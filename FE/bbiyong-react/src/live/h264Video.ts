const MAGIC = 0x42425631
const FIXED_HEADER_SIZE = 40
const MAX_ROBOT_ID_BYTES = 128
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024

export interface H264Packet {
  streamId: number
  sequence: bigint
  timestampMs: bigint
  keyframe: boolean
  codecConfigPresent: boolean
  width: number
  height: number
  fps: number
  robotId: string
  accessUnit: Uint8Array
}

/** Parse the same bounded, big-endian BBV1 envelope validated by the backend. */
export function parseH264Packet(packet: Uint8Array): H264Packet {
  if (packet.byteLength < FIXED_HEADER_SIZE) throw new Error('short BBV1 packet')
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  const magic = view.getUint32(0)
  const version = view.getUint8(4)
  const flags = view.getUint8(5)
  const headerSize = view.getUint16(6)
  const streamId = view.getUint32(8)
  const sequence = view.getBigUint64(12)
  const timestampMs = view.getBigUint64(20)
  const payloadSize = view.getUint32(28)
  const width = view.getUint16(32)
  const height = view.getUint16(34)
  const fps = view.getUint16(36)
  const robotIdSize = view.getUint16(38)

  if (magic !== MAGIC || version !== 1) throw new Error('unsupported BBV1 protocol')
  if ((flags & ~0x03) !== 0) throw new Error('unknown BBV1 flags')
  if (!robotIdSize || robotIdSize > MAX_ROBOT_ID_BYTES
      || headerSize !== FIXED_HEADER_SIZE + robotIdSize) throw new Error('invalid BBV1 header')
  if (!payloadSize || payloadSize > MAX_PAYLOAD_BYTES
      || headerSize + payloadSize !== packet.byteLength) throw new Error('invalid BBV1 payload')
  if (!width || !height || !fps) throw new Error('invalid BBV1 geometry')

  const robotBytes = packet.subarray(FIXED_HEADER_SIZE, headerSize)
  const robotId = new TextDecoder('utf-8', { fatal: true }).decode(robotBytes)
  if (!robotId.trim()) throw new Error('blank BBV1 robot id')

  return {
    streamId, sequence, timestampMs,
    keyframe: (flags & 0x01) !== 0,
    codecConfigPresent: (flags & 0x02) !== 0,
    width, height, fps, robotId,
    accessUnit: packet.subarray(headerSize),
  }
}

/** Low-latency Annex-B decoder. It resets to keyframe-gated state when overloaded. */
export class H264VideoDecoder {
  private decoder: VideoDecoder | null = null
  private streamId: number | null = null
  private waitingForKeyframe = true
  private canvas: HTMLCanvasElement | null = null
  private warnedUnsupported = false

  constructor(private readonly onFrame: (canvas: HTMLCanvasElement) => void) {}

  push(envelope: Uint8Array): void {
    if (typeof VideoDecoder === 'undefined') {
      if (!this.warnedUnsupported) {
        console.warn('[video] WebCodecs is unavailable; waiting for JPEG fallback frames')
        this.warnedUnsupported = true
      }
      return
    }

    let packet: H264Packet
    try { packet = parseH264Packet(envelope) }
    catch (error) { console.warn('[video] dropping malformed H.264 packet', error); return }

    if (packet.streamId !== this.streamId) {
      this.reset(packet.streamId)
    }
    if (this.decoder && this.decoder.decodeQueueSize > 8) {
      this.reset(packet.streamId)
    }
    if (this.waitingForKeyframe && !packet.keyframe) return

    try {
      this.ensureDecoder()
      this.decoder!.decode(new EncodedVideoChunk({
        type: packet.keyframe ? 'key' : 'delta',
        timestamp: Number(packet.timestampMs) * 1000,
        data: packet.accessUnit,
      }))
      if (packet.keyframe) this.waitingForKeyframe = false
    } catch (error) {
      console.warn('[video] H.264 decode rejected; waiting for a new keyframe', error)
      this.reset(packet.streamId)
    }
  }

  close(): void {
    this.closeDecoder()
    this.canvas = null
  }

  private ensureDecoder(): void {
    if (this.decoder) return
    this.decoder = new VideoDecoder({
      output: (frame) => {
        try {
          if (!this.canvas) this.canvas = document.createElement('canvas')
          if (this.canvas.width !== frame.displayWidth) this.canvas.width = frame.displayWidth
          if (this.canvas.height !== frame.displayHeight) this.canvas.height = frame.displayHeight
          const context = this.canvas.getContext('2d')
          if (!context) throw new Error('2D canvas is unavailable')
          context.drawImage(frame, 0, 0)
          this.onFrame(this.canvas)
        } finally {
          frame.close()
        }
      },
      error: (error) => {
        console.warn('[video] H.264 decoder error; waiting for a new keyframe', error)
        this.decoder = null
        this.waitingForKeyframe = true
      },
    })
    // No description means Annex-B input. Robot encoding is constrained to baseline profile.
    this.decoder.configure({ codec: 'avc1.42E01E', optimizeForLatency: true })
  }

  private reset(streamId: number): void {
    this.closeDecoder()
    this.streamId = streamId
    this.waitingForKeyframe = true
  }

  private closeDecoder(): void {
    if (!this.decoder) return
    try { this.decoder.close() } catch { /* already closed by the browser */ }
    this.decoder = null
  }
}
