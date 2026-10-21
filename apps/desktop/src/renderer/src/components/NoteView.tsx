import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// 笔记正文。相对链接（topic.md 与 *.mp4）交给上层在应用内打开，不弹新窗口。
export function NoteView({ markdown, onOpenLink }: { markdown: string; onOpenLink: (href: string) => void }) {
  const link: Components["a"] = (props) => {
    const { href, children, ...rest } = props;
    const internal = href !== undefined && !/^[a-z]+:/i.test(href);
    return (
      <a
        {...rest}
        href={href}
        target={internal ? undefined : "_blank"}
        rel={internal ? undefined : "noreferrer"}
        onClick={(e) => {
          if (href === undefined || !internal) return;
          e.preventDefault();
          onOpenLink(href);
        }}
        className="break-words text-[oklch(65%_0.14_265)] underline underline-offset-2 hover:text-[oklch(75%_0.14_265)] dark:text-[oklch(74%_0.13_250)] dark:hover:text-[oklch(85%_0.12_250)]"
      >
        {children}
      </a>
    );
  };

  return (
    <article className="text-[13px]/[20px] font-normal text-neutral-900 dark:text-neutral-100">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: link,
          h1: ({ children }) => (
            <h1 className="mt-6 mb-3 text-[24px]/[28px] font-[450] tracking-[-0.015em] first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-6 mb-3 text-[20px]/[26px] font-[450] tracking-[-0.015em]">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-5 mb-2 text-[16px]/[22px] font-[450]">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mt-4 mb-2 text-[14px]/[20px] font-[450]">{children}</h4>
          ),
          h5: ({ children }) => (
            <h5 className="mt-4 mb-2 text-[13px]/[18px] font-[450]">{children}</h5>
          ),
          h6: ({ children }) => (
            <h6 className="mt-4 mb-2 text-[12px]/[16px] font-[450] uppercase tracking-wide text-neutral-900/80 dark:text-neutral-100/80">
              {children}
            </h6>
          ),
          p: ({ children }) => <p className="my-3">{children}</p>,
          ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-5">{children}</ol>,
          li: ({ children }) => <li className="pl-1">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-4 border-l-2 border-neutral-900/20 pl-4 italic text-neutral-900/80 dark:border-neutral-100/20 dark:text-neutral-100/80">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-6 border-neutral-900/10 dark:border-neutral-100/10" />,
          pre: ({ children }) => (
            <pre className="my-4 overflow-x-auto rounded-[var(--rb-r-lg,10px) bg-neutral-900/5 p-3 font-mono text-[13px]/[20px] text-neutral-900 [scrollbar-width:thin] dark:bg-neutral-100/5 dark:text-neutral-100 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[13px]/[20px]">
              {children}
            </pre>
          ),
          code: ({ children }) => (
            <code className="rounded-[var(--rb-r-xs,4px) bg-neutral-900/8 px-1.5 py-0.5 font-mono text-[12px]/[18px] dark:bg-neutral-100/10">
              {children}
            </code>
          ),
          img: ({ src, alt }) => (
            <img src={src} alt={alt ?? ""} className="my-4 w-auto max-w-full rounded-[var(--rb-r-sm,6px)]" />
          ),
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto">
              <table className="w-full border-collapse text-left">{children}</table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="border-b border-neutral-900/15 dark:border-neutral-100/15">{children}</thead>
          ),
          th: ({ children }) => <th className="px-3 py-2 font-[450]">{children}</th>,
          td: ({ children }) => (
            <td className="border-b border-neutral-900/10 px-3 py-2 dark:border-neutral-100/10">{children}</td>
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </article>
  );
}
