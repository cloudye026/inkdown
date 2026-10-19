import { useDocs } from "../store/docs";
import { useUi } from "../store/ui";
import { closeDoc } from "../commands/fileOps";

interface Props {
  onActivate: (path: string) => void;
}

export function Tabs({ onActivate }: Props) {
  const docs = useDocs((s) => s.docs);
  const activePath = useDocs((s) => s.activePath);
  const openContextMenu = useUi((s) => s.openContextMenu);
  if (docs.length === 0) return null;

  return (
    <div className="tabs">
      {docs.map((d) => {
        const dirty = d.text !== d.saved;
        return (
          <div
            key={d.path}
            className={`tab${d.path === activePath ? " active" : ""}`}
            onClick={() => onActivate(d.path)}
            onContextMenu={(e) => {
              e.preventDefault();
              openContextMenu({ x: e.clientX, y: e.clientY, target: d.path, isDir: false });
            }}
            onAuxClick={(e) => {
              // 中键关闭
              if (e.button === 1) {
                e.preventDefault();
                void closeDoc(d.path);
              }
            }}
            title={d.path}
          >
            <span className="label">
              {d.name}
              {dirty ? " •" : ""}
            </span>
            <span
              className="close"
              onClick={(e) => {
                e.stopPropagation();
                void closeDoc(d.path);
              }}
            >
              ×
            </span>
          </div>
        );
      })}
    </div>
  );
}
