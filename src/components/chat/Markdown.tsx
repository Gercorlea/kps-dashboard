import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// El modelo responde en markdown (tablas, listas, negritas). Sin esto el
// chat pintaba el texto crudo y las tablas se veían como pipes.
// react-markdown NO usa dangerouslySetInnerHTML: el markdown se parsea a
// nodos de React, así que no hay inyección de HTML.
export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Las tablas anchas hacen scroll dentro de su caja, nunca la página.
        table: ({ children: c }) => (
          <div className="cr-md-tabla-caja">
            <table className="cr-md-tabla">{c}</table>
          </div>
        ),
        a: ({ children: c, href }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" className="cr-md-link">
            {c}
          </a>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
