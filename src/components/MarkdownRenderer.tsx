import React, { useState } from "react";
import Markdown from "react-markdown";
import { Copy, Check, Terminal } from "lucide-react";

interface MarkdownRendererProps {
  content: string;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content }) => {
  return (
    <div className="prose max-w-none text-zinc-800 leading-relaxed text-sm sm:text-base space-y-4">
      <Markdown
        components={{
          // Code Blocks and Inline Code Handler
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || "");
            const isCodeBlock = !props.style && (match || String(children).includes("\n"));
            const codeString = String(children).replace(/\n$/, "");

            if (isCodeBlock) {
              return <CodeBlock code={codeString} language={match ? match[1] : "code"} />;
            }

            return (
              <code className="text-rose-600 bg-zinc-100 font-mono text-[0.875em] px-1.5 py-0.5 rounded border border-zinc-200">
                {children}
              </code>
            );
          },
          // Elegant spacing for lists and standard markup
          p({ children }) {
            return <p className="mb-4 text-zinc-800 font-sans leading-relaxed">{children}</p>;
          },
          ul({ children }) {
            return <ul className="list-disc pl-6 mb-4 space-y-1 text-zinc-800 font-sans">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="list-decimal pl-6 mb-4 space-y-1 text-zinc-800 font-sans">{children}</ol>;
          },
          li({ children }) {
            return <li className="mb-1 leading-relaxed">{children}</li>;
          },
          h1({ children }) {
            return <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-950 mt-6 mb-3 border-b border-zinc-150 pb-2">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="text-lg sm:text-xl font-semibold tracking-tight text-zinc-900 mt-5 mb-2.5">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="text-base sm:text-lg font-medium tracking-tight text-zinc-900 mt-4 mb-2">{children}</h3>;
          },
          blockquote({ children }) {
            return (
              <blockquote className="border-l-4 border-zinc-300 pl-4 py-1.5 italic text-zinc-600 bg-zinc-50 rounded-r my-4">
                {children}
              </blockquote>
            );
          },
          table({ children }) {
            return (
              <div className="overflow-x-auto my-4 border border-zinc-200 rounded-lg shadow-xs">
                <table className="min-w-full divide-y divide-zinc-200 text-left text-sm">{children}</table>
              </div>
            );
          },
          thead({ children }) {
            return <thead className="bg-zinc-50 text-xs font-semibold uppercase text-zinc-600">{children}</thead>;
          },
          tbody({ children }) {
            return <tbody className="divide-y divide-zinc-200 bg-white">{children}</tbody>;
          },
          tr({ children }) {
            return <tr className="hover:bg-zinc-50/50">{children}</tr>;
          },
          th({ children }) {
            return <th className="px-4 py-3 font-medium text-zinc-900">{children}</th>;
          },
          td({ children }) {
            return <td className="px-4 py-2.5 text-zinc-700">{children}</td>;
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-zinc-900 underline font-medium hover:text-zinc-600 transition-colors"
              >
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </Markdown>
    </div>
  );
};

// Stateful CodeBlock component to handle clipboard copy events inside Markdown
interface CodeBlockProps {
  code: string;
  language: string;
}

const CodeBlock: React.FC<CodeBlockProps> = ({ code, language }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy code to clipboard", err);
    }
  };

  return (
    <div className="relative group border border-zinc-200 rounded-lg overflow-hidden my-5 bg-zinc-950 shadow-md">
      {/* Code Header bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-900 border-b border-zinc-800 text-xs text-zinc-400 font-mono">
        <div className="flex items-center gap-1.5 select-none">
          <Terminal size={14} className="text-zinc-500" />
          <span>{language.toUpperCase()}</span>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 hover:text-white transition-colors cursor-pointer px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-800"
          title="Copy code"
        >
          {copied ? (
            <>
              <Check size={12} className="text-emerald-400 animate-scale" />
              <span className="text-emerald-400 font-medium">Copied</span>
            </>
          ) : (
            <>
              <Copy size={12} />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Code Area */}
      <div className="overflow-x-auto p-4 font-mono text-[13px] sm:text-[14px] leading-relaxed text-zinc-100 bg-zinc-950">
        <pre className="whitespace-pre">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
};
