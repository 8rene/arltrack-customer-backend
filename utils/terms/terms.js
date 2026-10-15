// terms.js
// The Terms & Conditions now come from the server (GET /api/terms/active) instead of being
// hard-coded in two different components. The server builds the text (including the
// admin-managed deposit / fee % / refund window), hashes the RENDERED result, and records
// that hash when a customer accepts at signup or at booking — so the exact words they agreed
// to can be shown again later (GET /api/terms/version/:hash).
import { useCallback, useEffect, useState } from "react";

const BASE_URL = `${process.env.REACT_APP_API_URL}/terms`;
const CACHE_MS = 30_000;

let cache = null;
let cacheAt = 0;

// Rejects on failure (callers show a retry — there is deliberately NO hard-coded fallback:
// a fallback would be a text the server never recorded).
export const fetchActiveTerms = async ({ force = false } = {}) => {
  if (!force && cache && Date.now() - cacheAt < CACHE_MS) return cache;
  const res = await fetch(`${BASE_URL}/active`);
  if (!res.ok) throw new Error("Could not load the Terms & Conditions. Please try again.");
  cache = await res.json();
  cacheAt = Date.now();
  return cache;
};

export const fetchTermsVersion = async (hash) => {
  const res = await fetch(`${BASE_URL}/version/${encodeURIComponent(hash)}`);
  if (res.status === 404) throw new Error("That version of the Terms & Conditions was not found.");
  if (!res.ok) throw new Error("Could not load that version. Please try again.");
  return res.json();
};

// versionHash = null → the current terms; otherwise the exact version with that hash.
export const useTermsDocument = (versionHash = null) => {
  const [state, setState] = useState({ terms: versionHash ? null : cache, loading: true, error: "" });

  const load = useCallback(async (force = false) => {
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const terms = versionHash ? await fetchTermsVersion(versionHash) : await fetchActiveTerms({ force });
      setState({ terms, loading: false, error: "" });
      return terms;
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err.message || "Could not load the Terms & Conditions." }));
      return null;
    }
  }, [versionHash]);

  useEffect(() => { load(); }, [load]);

  return { ...state, reload: () => load(true) };
};

export const useActiveTerms = () => useTermsDocument(null);
