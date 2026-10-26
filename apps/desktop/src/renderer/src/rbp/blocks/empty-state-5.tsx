"use client";
import { useState, type DragEvent } from "react";

// empty-state-5 改造：视频库拖放区。点击或拖放都导入；没有单独的导入按钮。

type Props = {
  onImport: () => void;
  onImportPath: (path: string) => void;
  busy: boolean;
};

export default function DropZone({ onImport, onImportPath, busy }: Props) {
  const [dragging, setDragging] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    setDropError(null);
    if (busy) return;
    const file = e.dataTransfer.files[0];
    if (file === undefined) return;
    // pathForFile 只认真实文件系统里的 File，合成对象会抛错，按「拖进来的不是磁盘文件」处理
    let path: string;
    try {
      path = window.vnote.pathForFile(file);
    } catch {
      setDropError("拖进来的不是磁盘文件");
      return;
    }
    if (path === "") {
      setDropError("取不到文件路径");
      return;
    }
    onImportPath(path);
  };

  return (
    <div
      data-testid="dropzone"
      role="button"
      tabIndex={0}
      className={`vn-drop${dragging ? " dragging" : ""}`}
      onClick={() => {
        if (!busy) onImport();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (!busy) onImport();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div style={{ fontSize: 26 }} aria-hidden="true">
        ⇪
      </div>
      <h3>点击或拖放视频到这里</h3>
      <p>支持 mp4 / mov / m4a / mp3 / wav / flac 等 · 仅本地文件</p>
      {dropError !== null ? (
        <p className="vn-hint" style={{ marginTop: 8 }}>
          {dropError}
        </p>
      ) : null}
    </div>
  );
}
