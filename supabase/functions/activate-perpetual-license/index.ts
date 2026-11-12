import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type JsonObject = Record<string, unknown>;

function jsonResponse(body: JsonObject, status = 200, corsHeaders: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function allowedOriginHeaders(req: Request): HeadersInit | null {
  const origin = req.headers.get("origin");
  if (!origin) return {};
  const configured = (Deno.env.get("TERMLY_ALLOWED_ORIGINS") || "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const defaults = ["https://termly.com", "https://termly-app.vercel.app", "http://localhost:5173", "capacitor://localhost", "app://."];
  const allowed = new Set([...defaults, ...configured]);
  if (!allowed.has(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function verifyLicense(document: unknown, publicKeyBase64: string) {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Licence document must be a JSON object.");
  const candidate = document as Record<string, unknown>;
  const payload = candidate.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Licence payload is missing.");
  if (typeof candidate.signature !== "string" || candidate.signature.length > 1024) throw new Error("Licence signature is missing or invalid.");
  if (payload.schemaVersion !== 1 || payload.product !== "termly" || payload.licenseType !== "perpetual") throw new Error("Unsupported Termly licence format.");
  if (!isUuid(payload.schoolId)) throw new Error("Licence school ID is invalid.");
  if (typeof payload.licenseId !== "string" || !/^TLY-[A-Z0-9-]{8,90}$/i.test(payload.licenseId)) throw new Error("Licence ID is invalid.");
  if (typeof payload.schoolName !== "string" || !payload.schoolName.trim() || payload.schoolName.length > 200) throw new Error("Licence school name is invalid.");
  if (typeof payload.issuedAt !== "string" || Number.isNaN(Date.parse(payload.issuedAt))) throw new Error("Licence issue date is invalid.");
  if (Date.parse(payload.issuedAt) > Date.now() + 5 * 60 * 1000) throw new Error("Licence issue date is in the future.");
  if (payload.supportUntil !== null && payload.supportUntil !== undefined && payload.supportUntil !== "") {
    if (typeof payload.supportUntil !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(payload.supportUntil)) {
      throw new Error("Support-through date must use YYYY-MM-DD.");
    }
    const [year, month, day] = payload.supportUntil.split("-").map(Number);
    const dateCheck = new Date(Date.UTC(year, month - 1, day));
    if (dateCheck.getUTCFullYear() !== year || dateCheck.getUTCMonth() !== month - 1 || dateCheck.getUTCDate() !== day) {
      throw new Error("Support-through date is not a valid calendar date.");
    }
  }
  const entitlements = payload.entitlements as Record<string, unknown> | undefined;
  const features = entitlements?.features;
  if (!Array.isArray(features) || features.length === 0 || features.length > 200
      || features.some((item) => typeof item !== "string" || !item.trim() || item.length > 100)
      || new Set(features).size !== features.length) {
    throw new Error("Licence feature entitlements are invalid or duplicated.");
  }
  if (features.includes("*") && features.length !== 1) throw new Error("Wildcard feature entitlement must be used by itself.");

  const publicKey = await crypto.subtle.importKey(
    "spki", decodeBase64(publicKeyBase64), { name: "Ed25519" }, false, ["verify"],
  );
  const signatureValid = await crypto.subtle.verify(
    { name: "Ed25519" }, publicKey, decodeBase64(candidate.signature),
    new TextEncoder().encode(canonicalize(payload)),
  );
  if (!signatureValid) throw new Error("Licence signature verification failed. The file may have been modified or issued by an untrusted signer.");
  return payload;
}

serve(async (req) => {
  const corsHeaders = allowedOriginHeaders(req);
  if (corsHeaders === null) return jsonResponse({ success: false, error: "Origin is not allowed." }, 403);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "Method not allowed." }, 405, corsHeaders);

  try {
    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).byteLength > 64 * 1024) {
      return jsonResponse({ success: false, error: "Licence upload is too large." }, 413, corsHeaders);
    }
    let body: Record<string, unknown>;
    try { body = JSON.parse(rawBody) as Record<string, unknown>; }
    catch { return jsonResponse({ success: false, error: "Request body must be valid JSON." }, 400, corsHeaders); }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const publicKey = Deno.env.get("TERMLY_LICENSE_PUBLIC_KEY") || "";
    if (!supabaseUrl || !anonKey || !serviceKey || !publicKey) {
      return jsonResponse({ success: false, error: "Licensing service is not configured on this Termly server." }, 503, corsHeaders);
    }

    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return jsonResponse({ success: false, error: "Please sign in as this school's administrator." }, 401, corsHeaders);

    const supabaseUser = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await supabaseUser.auth.getUser();
    if (authError || !user) return jsonResponse({ success: false, error: "Your session is invalid or has expired." }, 401, corsHeaders);

    const licenseDocument = body?.licenseDocument;
    const payload = await verifyLicense(licenseDocument, publicKey);
    const schoolId = payload.schoolId as string;

    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const [{ data: schoolUsers, error: userLookupError }, { data: school, error: schoolLookupError }] = await Promise.all([
      supabaseAdmin.from("users").select("school_id, role").eq("auth_user_id", user.id),
      supabaseAdmin.from("schools").select("id, owner_id").eq("id", schoolId).maybeSingle(),
    ]);
    if (userLookupError || schoolLookupError) throw new Error("Could not verify the signed-in school administrator.");
    const isSchoolAdmin = (schoolUsers || []).some((membership) => membership.school_id === schoolId && String(membership.role || "").toLowerCase() === "admin");
    const isSchoolOwner = school?.owner_id === user.id;
    if (!school || (!isSchoolAdmin && !isSchoolOwner)) {
      return jsonResponse({ success: false, error: "Only this school's administrator or registered owner can activate its licence." }, 403, corsHeaders);
    }

    const { data: existingProfile, error: profileError } = await supabaseAdmin
      .from("school_profiles")
      .select("license_type, license_status")
      .eq("school_id", schoolId)
      .maybeSingle();
    if (profileError) throw new Error("Could not inspect the current school licence state.");
    if (String(existingProfile?.license_type || "").toLowerCase() === "perpetual"
        && String(existingProfile?.license_status || "").toLowerCase() === "suspended") {
      return jsonResponse({ success: false, error: "This perpetual licence is suspended by the platform administrator. Re-uploading the licence cannot remove that suspension." }, 403, corsHeaders);
    }

    const { data, error } = await supabaseAdmin.rpc("termly_apply_perpetual_license", {
      p_school_id: schoolId,
      p_license_document: licenseDocument,
      p_actor_id: user.id,
      p_actor_email: user.email || null,
    });
    if (error) throw new Error(error.message || "Database could not apply the licence.");

    return jsonResponse({ success: true, licenseId: data?.license_id || payload.licenseId, schoolId }, 200, corsHeaders);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Licence activation failed.";
    console.error("[activate-perpetual-license]", message);
    return jsonResponse({ success: false, error: message }, 400, corsHeaders);
  }
});
