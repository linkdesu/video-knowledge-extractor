import type { LibraryVideo } from "../../../shared/ipc";
import { CountUp } from "../components/CountUp";
import { Spotlight } from "../components/Spotlight";
import { formatUpdated } from "../lib/format";

type Props = {
  videos: LibraryVideo[];
  busy: boolean;
  onOpen: (video: LibraryVideo) => void;
  onImport: () => void;
  onRerun: (video: LibraryVideo) => void;
};

export function LibraryView({ videos, busy, onOpen, onImport, onRerun }: Props) {
  const topicTotal = videos.reduce((sum, v) => sum + v.topicCount, 0);
  const clipTotal = videos.reduce((sum, v) => sum + v.clipCount, 0);

  return (
    <div className="library">
      <div className="library__header">
        <div className="library__stats">
          <div className="stat">
            <CountUp value={videos.length} />
            <span>个视频</span>
          </div>
          <div className="stat">
            <CountUp value={topicTotal} />
            <span>个主题</span>
          </div>
          <div className="stat">
            <CountUp value={clipTotal} />
            <span>个切片</span>
          </div>
        </div>
        <button type="button" className="btn btn--primary" onClick={onImport} disabled={busy}>
          导入视频
        </button>
      </div>
      {videos.length === 0 ? (
        <div className="library__empty">
          <Spotlight />
          <h2>还没有处理过的视频</h2>
          <p>导入一个视频，把长视频变成按主题阅读的文字笔记和切片。</p>
          <button type="button" className="btn btn--primary" onClick={onImport} disabled={busy}>
            导入视频
          </button>
        </div>
      ) : (
        <div className="library__grid">
          {videos.map((v) => (
            <article className="card" key={v.id} onClick={() => onOpen(v)}>
              <h3 className="card__title">{v.title}</h3>
              <div className="card__meta">
                <span>{v.topicCount} 个主题</span>
                <span>{v.clipCount} 个切片</span>
                <span>{formatUpdated(v.updatedAt)}</span>
              </div>
              <div className="card__actions">
                <button
                  type="button"
                  className="btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRerun(v);
                  }}
                  disabled={busy}
                >
                  重跑
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
