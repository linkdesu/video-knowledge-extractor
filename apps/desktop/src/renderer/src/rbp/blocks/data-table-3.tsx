"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Delete01Icon } from "@hugeicons/core-free-icons";

const cx = (...c: (string | false | null | undefined)[]) =>
  c.filter(Boolean).join(" ");

const canvas = "bg-white dark:bg-neutral-950";
const greyFrame = "bg-neutral-50 dark:bg-neutral-900";
const text1 = "text-neutral-900 dark:text-neutral-100";
const text2 = "text-neutral-900/80 dark:text-neutral-100/80";
const text3 = "text-neutral-900/66 dark:text-neutral-100/66";
const typeHeadingXs = "text-[16px]/[20px] font-[450] tracking-[-0.015em]";
const typeBodySm = "text-[13px]/[18px] font-normal";
const secondaryButton =
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap select-none transition-[color,background-color,border-color,box-shadow,outline-color,scale,filter] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] active:scale-[0.98] active:duration-[60ms] motion-reduce:active:scale-100 disabled:cursor-not-allowed aria-busy:cursor-progress focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--rb-accent,oklch(20.5%_0_0))] dark:focus-visible:outline-[var(--rb-accent,oklch(100%_0_0))] border border-neutral-900/12 bg-white text-neutral-900 shadow-[0_1px_2px_-1px_rgb(0_0_0/0.12)] hover:not-disabled:border-neutral-900/32 hover:not-disabled:bg-linear-to-b hover:not-disabled:from-neutral-900/3 hover:not-disabled:to-neutral-900/3 active:shadow-[inset_0_1px_2px_rgb(0_0_0/0.12)] disabled:border-neutral-900/8 disabled:text-neutral-900/40 disabled:shadow-none dark:border-neutral-100/14 dark:bg-neutral-900 dark:text-neutral-100 dark:shadow-[0_1px_2px_-1px_rgb(0_0_0/0.36)] dark:hover:not-disabled:border-neutral-100/32 dark:hover:not-disabled:from-neutral-100/3 dark:hover:not-disabled:to-neutral-100/3 dark:active:shadow-[inset_0_1px_2px_rgb(0_0_0/0.4)] dark:disabled:border-neutral-100/8 dark:disabled:text-neutral-100/40";
const buttonSm =
  "h-7 gap-1.5 rounded-[var(--rb-r-sm,6px)] px-3 text-[14px]/[16px] font-[450]";
const inputBox =
  "relative flex w-full min-w-0 cursor-text items-center rounded-[var(--rb-r-sm,6px)] data-concentric:rounded-[var(--rb-r-lg,10px)] border border-neutral-900/12 bg-white text-[14px]/[16px] font-[450] text-neutral-900 shadow-[0_1px_2px_-1px_rgb(0_0_0/0.12)] transition-[border-color,box-shadow,background-color] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] hover:not-focus-within:border-neutral-900/32 focus-within:border-[var(--rb-accent,oklch(20.5%_0_0))] focus-within:ring-3 focus-within:ring-neutral-900/8 has-[input:disabled]:cursor-not-allowed has-[input:disabled]:border-neutral-900/8 has-[input:disabled]:text-neutral-900/40 has-[input:disabled]:shadow-none dark:border-neutral-100/14 dark:bg-neutral-900 dark:text-neutral-100 dark:shadow-[0_1px_2px_-1px_rgb(0_0_0/0.36)] dark:hover:not-focus-within:border-neutral-100/32 dark:focus-within:border-[var(--rb-accent,oklch(100%_0_0))] dark:focus-within:ring-neutral-100/8 dark:has-[input:disabled]:border-neutral-100/8 dark:has-[input:disabled]:text-neutral-100/40";
const fieldSm = "h-7";
const inputControl =
  "h-full w-full min-w-0 flex-1 bg-transparent px-3 outline-none placeholder:text-neutral-900/66 disabled:cursor-not-allowed disabled:placeholder:text-neutral-900/40 dark:placeholder:text-neutral-100/66 dark:disabled:placeholder:text-neutral-100/40 dark:[color-scheme:dark]";
const statusOk = "text-neutral-900/80 dark:text-neutral-100/80";
const statusWarn = "text-[oklch(49%_0.1_68)] dark:text-[oklch(80%_0.13_68)]";
const table =
  "w-full border-separate border-spacing-0 text-left text-[14px]/[20px]";
const tableHead =
  "h-8 border-b border-neutral-900/8 px-3 text-left align-middle text-[12px]/[16px] font-normal tabular-nums whitespace-nowrap text-neutral-900/66 dark:text-neutral-100/66 first:ps-4 last:pe-4 dark:border-neutral-100/8";
const tableRow =
  "group transition-[background-color] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] hover:bg-neutral-900/5 dark:hover:bg-neutral-100/5";
const tableCell =
  "h-10 border-b border-neutral-900/8 px-3 align-middle text-neutral-900 dark:text-neutral-100 group-last:border-b-0 first:ps-4 last:pe-4 dark:border-neutral-100/8";
const gutter = "sm:first:ps-6 sm:last:pe-6";

type Cell = {
  wrong: string;
  right: string;
};

type Props = {
  rows: Cell[];
  busy: boolean;
  status: string | null;
  onEditCell: (index: number, key: keyof Cell, value: string) => void;
  onRemoveRow: (index: number) => void;
  onAddRow: () => void;
  onSave: (andRerun: boolean) => void;
};

// 纠错词表：行内直接编辑，状态条与操作按钮在表脚；外层负责数据与 IPC。
export function CorrectionsTable({
  rows,
  busy,
  status,
  onEditCell,
  onRemoveRow,
  onAddRow,
  onSave,
}: Props) {
  return (
    <section data-testid="corrections" className={cx(canvas, text1, "flex flex-col")}>
      <header
        className={cx(
          greyFrame,
          "flex h-14 shrink-0 items-center gap-3 px-4 sm:px-6",
        )}
      >
        <div className="min-w-0 flex-1">
          <h2 className={cx(typeHeadingXs, "truncate")}>纠错词表</h2>
          <p className={cx(typeBodySm, text2, "truncate")}>
            把识别错的词改成正确写法
          </p>
        </div>
      </header>

      <div className="overflow-x-auto">
        <table className={cx(table, "min-w-[520px]")}>
          <caption className="sr-only">
            纠错词表：识别错误到正确写法的对应关系
          </caption>
          <thead className={canvas}>
            <tr>
              <th scope="col" className={cx(tableHead, gutter)}>
                识别错误
              </th>
              <th scope="col" className={cx(tableHead, gutter)}>
                正确写法
              </th>
              <th
                scope="col"
                className={cx(tableHead, gutter, "w-[72px] text-right")}
              >
                <span className="sr-only">删除</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={3}
                  className={cx(
                    tableCell,
                    gutter,
                    "h-24",
                  )}
                >
                  <span className={cx(typeBodySm, text2)}>
                    还没有词条，点下方「添加一行」把识别错的词改成正确写法
                  </span>
                </td>
              </tr>
            )}
            {rows.map((row, i) => (
              <tr key={i} className={tableRow} data-testid="correction-row">
                <td className={cx(tableCell, gutter, "min-w-[180px]")}>
                  <span className={cx(inputBox, fieldSm)}>
                    <input
                      type="text"
                      value={row.wrong}
                      placeholder="原文"
                      aria-label="识别错误"
                      data-testid="correction-wrong"
                      onChange={(e) => onEditCell(i, "wrong", e.target.value)}
                      className={inputControl}
                    />
                  </span>
                </td>
                <td className={cx(tableCell, gutter, "min-w-[180px]")}>
                  <span className={cx(inputBox, fieldSm)}>
                    <input
                      type="text"
                      value={row.right}
                      placeholder="改写成"
                      aria-label="正确写法"
                      data-testid="correction-right"
                      onChange={(e) => onEditCell(i, "right", e.target.value)}
                      className={inputControl}
                    />
                  </span>
                </td>
                <td className={cx(tableCell, gutter, "text-right")}>
                  <button
                    type="button"
                    onClick={() => onRemoveRow(i)}
                    aria-label="删除这一行"
                    data-testid="correction-delete"
                    className={cx(secondaryButton, buttonSm)}
                  >
                    <HugeiconsIcon
                      icon={Delete01Icon}
                      size={16}
                      strokeWidth={1.8}
                      aria-hidden="true"
                      className={cx(text3, "shrink-0")}
                    />
                    删
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer
        className={cx(
          greyFrame,
          "flex h-12 shrink-0 items-center justify-between gap-3 px-4 sm:px-6",
        )}
      >
        <button
          type="button"
          data-testid="correction-add"
          onClick={onAddRow}
          className={cx(secondaryButton, buttonSm)}
        >
          添加一行
        </button>
        <div className="flex items-center gap-3">
          {status !== null && (
            <span
              data-testid="correction-status"
              className={cx(typeBodySm, status === "已保存" ? statusOk : statusWarn)}
            >
              {status}
            </span>
          )}
          <button
            type="button"
            data-testid="correction-save"
            onClick={() => onSave(false)}
            disabled={busy}
            className={cx(secondaryButton, buttonSm)}
          >
            保存
          </button>
          <button
            type="button"
            data-testid="correction-save-rerun"
            onClick={() => onSave(true)}
            disabled={busy}
            className={cx(secondaryButton, buttonSm)}
          >
            保存并重跑
          </button>
        </div>
      </footer>
    </section>
  );
}
