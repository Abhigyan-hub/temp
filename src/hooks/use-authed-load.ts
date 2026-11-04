import { useEffect } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api";
import { useApp } from "@/lib/store";

/** Run a data load once the session is confirmed (and again whenever `deps` change). */
export function useAuthedLoad(load: () => Promise<unknown>, deps: unknown[] = []) {
  const ready = useApp((s) => s.authStatus === "authenticated");
  useEffect(() => {
    if (!ready) return;
    load().catch((err) => toast.error(errorMessage(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, ...deps]);
}
