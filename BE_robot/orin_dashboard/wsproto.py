"""
최소 WebSocket 서버 구현 (RFC 6455) — 표준 라이브러리만 사용

왜 직접 구현하나
  로봇에 pip 의존성(websockets, fastapi 등)을 늘리지 않기 위해서다.
  대시보드가 쓰는 기능은 "서버가 JSON을 밀고, 클라이언트가 가끔 명령을 보낸다"뿐이라
  RFC 6455 중 필요한 부분만 구현하면 200줄이 안 된다.

구현 범위
  ✅ 핸드셰이크, 텍스트 프레임 송수신, ping/pong, close, 마스킹 해제
  ✅ 확장 길이(126/127) 처리
  ❌ 단편화(continuation frame) 조립 — 대시보드는 프레임 하나에 JSON 하나라 불필요.
     받으면 무시하고 close 한다.
  ❌ 확장(permessage-deflate), 서브프로토콜 협상 — 쓰지 않는다.

보안 메모
  이 서버는 127.0.0.1 에만 바인딩되고 SSH 터널로만 노출된다.
  따라서 Origin 검사나 인증을 여기서 하지 않는다 — 터널에 들어올 수 있다는 것 자체가 인증이다.
  만약 나중에 공인망에 직접 노출한다면 Origin 검사와 토큰 인증을 반드시 추가해야 한다.
"""

import base64
import hashlib
import os
import struct

# RFC 6455 가 규정한 고정 GUID. 핸드셰이크 응답 키를 만들 때 쓴다.
_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# 오피코드
OP_CONT = 0x0
OP_TEXT = 0x1
OP_BIN = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA

MAX_PAYLOAD = 1 << 20          # 1 MiB. 대시보드 명령은 수백 바이트면 충분하다


class WebSocketError(Exception):
    pass


class ClosedError(WebSocketError):
    """상대가 닫았거나 소켓이 끊겼다. 정상 종료 경로."""


def accept_key(client_key: str) -> str:
    """
    Sec-WebSocket-Key 로부터 Sec-WebSocket-Accept 를 만든다.
    base64( sha1( key + GUID ) ) — RFC 6455 §4.2.2
    """
    digest = hashlib.sha1(client_key.strip().encode() + _GUID).digest()
    return base64.b64encode(digest).decode()


def handshake_response(client_key: str) -> bytes:
    """101 Switching Protocols 응답 바이트를 만든다."""
    return (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept_key(client_key)}\r\n"
        "\r\n"
    ).encode()


# ─────────────────────────────────────────────────────────────
# 프레임 인코딩 (서버 → 클라이언트)
#
#   서버가 보내는 프레임은 마스킹하지 않는다 (RFC 6455 §5.1).
#   클라이언트가 보내는 프레임은 반드시 마스킹되어야 한다.
# ─────────────────────────────────────────────────────────────
def encode_frame(payload: bytes, opcode: int = OP_TEXT) -> bytes:
    header = bytearray()
    header.append(0x80 | opcode)               # FIN=1 + opcode

    length = len(payload)
    if length < 126:
        header.append(length)                  # MASK=0 + 길이
    elif length < (1 << 16):
        header.append(126)
        header += struct.pack("!H", length)
    else:
        header.append(127)
        header += struct.pack("!Q", length)

    return bytes(header) + payload


def encode_text(text: str) -> bytes:
    return encode_frame(text.encode("utf-8"), OP_TEXT)


def encode_close(code: int = 1000, reason: str = "") -> bytes:
    return encode_frame(struct.pack("!H", code) + reason.encode("utf-8"), OP_CLOSE)


# ─────────────────────────────────────────────────────────────
# 프레임 디코딩 (클라이언트 → 서버)
# ─────────────────────────────────────────────────────────────
def _recv_exactly(sock, n: int) -> bytes:
    """정확히 n 바이트를 읽는다. 못 채우면 연결이 끊긴 것이다."""
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ClosedError("소켓이 닫혔습니다")
        buf += chunk
    return bytes(buf)


def read_frame(sock):
    """
    프레임 하나를 읽어 (opcode, payload) 로 돌려준다.
    소켓에 recv 타임아웃이 걸려 있으면 socket.timeout 이 그대로 올라온다 — 호출자가 처리한다.
    """
    b0, b1 = _recv_exactly(sock, 2)

    fin = b0 & 0x80
    opcode = b0 & 0x0F
    masked = b1 & 0x80
    length = b1 & 0x7F

    if length == 126:
        (length,) = struct.unpack("!H", _recv_exactly(sock, 2))
    elif length == 127:
        (length,) = struct.unpack("!Q", _recv_exactly(sock, 8))

    if length > MAX_PAYLOAD:
        raise WebSocketError(f"페이로드가 너무 큽니다: {length}")

    # RFC 6455 §5.1 — 클라이언트가 보내는 프레임은 반드시 마스킹되어야 한다
    if not masked:
        raise WebSocketError("클라이언트 프레임이 마스킹되지 않았습니다")

    mask = _recv_exactly(sock, 4)
    payload = bytearray(_recv_exactly(sock, length))
    for i in range(length):
        payload[i] ^= mask[i & 3]

    if not fin:
        # 단편화는 지원하지 않는다 (구현 범위 참고)
        raise WebSocketError("단편화된 프레임은 지원하지 않습니다")

    return opcode, bytes(payload)


# ─────────────────────────────────────────────────────────────
# 연결 래퍼
# ─────────────────────────────────────────────────────────────
class WebSocket:
    """
    업그레이드가 끝난 소켓을 감싼다.
    send 는 여러 스레드에서 불릴 수 있으므로 락으로 직렬화한다
    (송신 스레드 + ping 응답이 겹칠 수 있다).
    """

    def __init__(self, sock, lock):
        self.sock = sock
        self._lock = lock
        self.closed = False

    def send_text(self, text: str):
        self._send_raw(encode_text(text))

    def send_pong(self, payload: bytes):
        self._send_raw(encode_frame(payload, OP_PONG))

    def send_ping(self, payload: bytes = b""):
        self._send_raw(encode_frame(payload, OP_PING))

    def close(self, code: int = 1000, reason: str = ""):
        if self.closed:
            return
        try:
            self._send_raw(encode_close(code, reason))
        except (OSError, WebSocketError):
            pass
        finally:
            self.closed = True

    def _send_raw(self, data: bytes):
        if self.closed:
            raise ClosedError("이미 닫힌 연결입니다")
        with self._lock:
            try:
                self.sock.sendall(data)
            except (BrokenPipeError, ConnectionResetError, OSError) as exc:
                self.closed = True
                raise ClosedError(str(exc)) from exc

    def read(self):
        """
        제어 프레임(ping/close)은 여기서 자동 처리하고,
        애플리케이션 메시지(텍스트)만 문자열로 돌려준다.
        닫혔으면 ClosedError 를 던진다.
        """
        while True:
            opcode, payload = read_frame(self.sock)

            if opcode == OP_CLOSE:
                self.closed = True
                raise ClosedError("클라이언트가 close 를 보냈습니다")

            if opcode == OP_PING:
                self.send_pong(payload)
                continue

            if opcode == OP_PONG:
                continue                          # 우리가 보낸 ping 에 대한 응답

            if opcode == OP_TEXT:
                return payload.decode("utf-8", errors="replace")

            if opcode == OP_BIN:
                continue                          # 대시보드는 바이너리를 쓰지 않는다

            raise WebSocketError(f"알 수 없는 opcode: {opcode}")
