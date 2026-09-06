// Token Saver screen: three fixed rows (RTK, Caveman, Ponytail) with
// per-row enable toggles and level buttons for Caveman/Ponytail.

import { useState } from "react";
import { get, send, ApiError, type TokenSaverSettings, type TokenSaverLevel } from "./api.ts";
import { Notice, useAsync, useToast } from "./app.tsx";
import { Badge, Button, Card, Icon, SectionHeader, Skeleton, Toggle } from "./primitives.tsx";

const LEVELS: TokenSaverLevel[] = ["lite", "full", "ultra"];

export function TokenSaverScreen() {
  const { data, error, loading, refresh } = useAsync(() => get<TokenSaverSettings>("/api/admin/token-saver"), []);
  const notify = useToast();
  const [pending, setPending] = useState<string | null>(null);

  const patch = async (patch: Partial<TokenSaverSettings>, label: string) => {
    setPending(label);
    const previous = data;
    try {
      await send("/api/admin/token-saver", "PATCH", patch);
      refresh();
      notify(`${label} updated.`, "success");
    } catch (reason) {
      notify(reason instanceof ApiError ? reason.message : String(reason), "error");
    } finally {
      setPending(null);
      void previous;
    }
  };

  return (
    <section>
      <SectionHeader title="Token Saver" description="Compress tool output and bias the model toward concise responses." />
      {loading && <Skeleton rows={3} />}
      {error && <Notice kind="error">Failed to load Token Saver settings: {error}</Notice>}
      {data && (
        <Card className="token-saver-card">
          <div className="token-saver-row">
            <div className="token-saver-info">
              <strong>Compress tool output (RTK)</strong>
              <small>Compress git diffs, grep output, and other verbose tool results before they reach the model.</small>
            </div>
            <Toggle checked={data.rtkEnabled} disabled={pending === "rtk"} label="RTK compression" onChange={(enabled) => patch({ rtkEnabled: enabled }, "RTK")} />
          </div>
          <div className="token-saver-row">
            <div className="token-saver-info">
              <strong>Compress LLM output (Caveman)</strong>
              <small>Bias the model toward terse, fragment-style responses while keeping technical substance exact.</small>
            </div>
            <div className="token-saver-controls">
              <Toggle checked={data.cavemanEnabled} disabled={pending?.startsWith("caveman") === true} label="Caveman" onChange={(enabled) => patch({ cavemanEnabled: enabled }, "Caveman")} />
              {data.cavemanEnabled && (
                <div className="token-saver-levels">
                  {LEVELS.map((level) => (
                    <button key={level} type="button" className="token-saver-level" aria-pressed={data.cavemanLevel === level} disabled={pending === "cavemanLevel"} onClick={() => patch({ cavemanLevel: level }, "Caveman level")}>
                      {level[0]!.toUpperCase() + level.slice(1)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="token-saver-row">
            <div className="token-saver-info">
              <strong>Lazy senior dev (Ponytail)</strong>
              <small>Bias the model toward minimal, deletion-first code with YAGNI enforcement.</small>
            </div>
            <div className="token-saver-controls">
              <Toggle checked={data.ponytailEnabled} disabled={pending?.startsWith("ponytail") === true} label="Ponytail" onChange={(enabled) => patch({ ponytailEnabled: enabled }, "Ponytail")} />
              {data.ponytailEnabled && (
                <div className="token-saver-levels">
                  {LEVELS.map((level) => (
                    <button key={level} type="button" className="token-saver-level" aria-pressed={data.ponytailLevel === level} disabled={pending === "ponytailLevel"} onClick={() => patch({ ponytailLevel: level }, "Ponytail level")}>
                      {level[0]!.toUpperCase() + level.slice(1)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Card>
      )}
    </section>
  );
}
