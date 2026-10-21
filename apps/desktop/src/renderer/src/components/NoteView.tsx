import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// 笔记正文。相对链接（topic.md 与 *.mp4）交给上层在应用内打开，不弹新窗口。
export function NoteView({ markdown, onOpenLink }: { markdown: string; onOpenLink: (href: string) => void }) {
  return (
    <article className="note">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a(props) {
            const { node: _node, href, children, ...rest } = props;
            const internal = href !== undefined && !/^[a-z]+:/i.test(href);
            return (
              <a
                {...rest}
                href={href}
                target={internal ? undefined : "_blank"}
                onClick={(e) => {
                  if (href === undefined || !internal) return;
                  e.preventDefault();
                  onOpenLink(href);
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </article>
  );
}
