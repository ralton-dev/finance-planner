import { useEffect, useState } from "react";
import { api } from "./api.js";
import type { MetaDto } from "./types.js";

/** Every flag off — what an unanswered probe means. */
const NOTHING_ON: MetaDto = { demoSeedEnabled: false, planDebugEnabled: false };

/**
 * Which optional features this deployment has turned on, probed once.
 *
 * **Fails closed.** A meta call that errors, or a deployment too old to publish
 * a flag, reads as "off" — so an optional feature stays hidden rather than
 * dead-ending somebody on a route the API will 404. The login screen probes for
 * SSO the same way.
 */
export function useMeta(): MetaDto {
  const [meta, setMeta] = useState<MetaDto>(NOTHING_ON);
  useEffect(() => {
    let cancelled = false;
    void api
      .meta()
      .then((next) => {
        if (!cancelled) setMeta(next);
      })
      .catch(() => {
        /* no meta — leave every flag off */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return meta;
}
