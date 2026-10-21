/** 空状态背景光斑：两个暖色径向渐变缓慢漂动。纯 CSS，无依赖。 */
export function Spotlight() {
  return (
    <div className="spotlight" aria-hidden="true">
      <div className="spotlight__glow spotlight__glow--a" />
      <div className="spotlight__glow spotlight__glow--b" />
    </div>
  );
}
