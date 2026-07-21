import { useSim } from '../../SimContext.js'

// 2D 맵핑 지도 (SLAM · LiDAR)
export default function MapPanel() {
  const { refs } = useSim()
  return (
    <div className="panel" id="pMap">
      <h3>2D 맵핑 지도 <span className="k">SLAM · LiDAR</span></h3>
      <div className="vwrap" style={{ background: '#0a0c10' }}><canvas ref={refs.map2d} /></div>
      <div className="maplegend">
        <span><i style={{ background: '#3ddc97' }} />오린카</span>
        <span><i style={{ background: '#3f8fe0' }} />순찰 경로</span>
        <span><i style={{ background: '#f5a623' }} />분전반</span>
        <span><i style={{ background: '#ff5648' }} />화재 지점</span>
        <span><i style={{ background: '#59637a' }} />장애물(SLAM)</span>
      </div>
    </div>
  )
}
