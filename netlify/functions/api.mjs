import { getStore } from "@netlify/blobs";
import { scrypt, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptP = promisify(scrypt);
const db = (name) => getStore({ name, consistency: "strong" });
const DAY = 864e5;
const DROP_DAYS = 7;
const INVITE_MS = 48 * 36e5;
const KINDS = ["note", "code", "photo"];

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
const bad = (msg, status = 400) => json({ error: msg }, status);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const rid = (n = 8) => randomBytes(n).toString("hex");

async function hashPw(pw, salt = rid(16)) {
  const h = await scryptP(pw, salt, 64);
  return `${salt}:${h.toString("hex")}`;
}
async function checkPw(pw, stored) {
  const [salt, hex] = stored.split(":");
  const a = Buffer.from(hex, "hex");
  const b = await scryptP(pw, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function startSession(user) {
  const token = rid(32);
  await db("sessions").setJSON(sha(token), { uid: user.id, codename: user.codename, exp: Date.now() + 30 * DAY });
  return `brush_s=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 86400}`;
}
async function whoAmI(req) {
  const m = /brush_s=([a-f0-9]+)/.exec(req.headers.get("cookie") || "");
  if (!m) return null;
  const s = await db("sessions").get(sha(m[1]), { type: "json" });
  return s && s.exp > Date.now() ? { id: s.uid, codename: s.codename } : null;
}

async function memberOf(me, cid) {
  const ch = await db("channels").get(cid, { type: "json" });
  if (!ch || !ch.users.some((u) => u.id === me.id)) return null;
  return ch;
}

async function loadDrops(cid) {
  const store = db("drops");
  const { blobs } = await store.list({ prefix: cid + "/" });
  const rows = await Promise.all(
    blobs.map(async (b) => ({ key: b.key, val: await store.get(b.key, { type: "json" }) }))
  );
  const live = [];
  for (const r of rows) {
    if (!r.val || r.val.exp < Date.now()) await store.delete(r.key);
    else live.push({ id: r.key, ...r.val });
  }
  return live.sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, 50);
}

export default async (req) => {
  const url = new URL(req.url);
  const [a, b, c] = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const M = req.method;
  if (M !== "GET" && req.headers.get("x-brush") !== "1") return bad("Blocked.", 403);
  let body = {};
  if (M === "POST") body = await req.json().catch(() => ({}));

  try {
    if (a === "signup" && M === "POST") {
      const { codename, password } = body;
      if (!/^[A-Za-z0-9_]{3,20}$/.test(codename || "")) return bad("Codename: 3 to 20 letters, digits or underscores.");
      if (typeof password !== "string" || password.length < 10) return bad("Password needs at least 10 characters.");
      const names = db("names");
      const key = codename.toLowerCase();
      if (await names.get(key, { type: "json" })) return bad("That codename is taken.", 409);
      const user = { id: rid(8), codename, pw: await hashPw(password), created: Date.now() };
      await db("users").setJSON(user.id, user);
      await names.setJSON(key, { id: user.id });
      return json({ codename }, 200, { "set-cookie": await startSession(user) });
    }

    if (a === "login" && M === "POST") {
      const key = String(body.codename || "").toLowerCase();
      const tries = db("tries");
      const t = (await tries.get(key, { type: "json" })) || { n: 0, until: 0 };
      if (t.until > Date.now()) return bad("Too many tries. Wait a few minutes.", 429);
      const ref = await db("names").get(key, { type: "json" });
      const user = ref && (await db("users").get(ref.id, { type: "json" }));
      if (!user || !(await checkPw(String(body.password || ""), user.pw))) {
        t.n += 1;
        t.until = t.n >= 5 ? Date.now() + 15 * 60000 : 0;
        if (t.n >= 5) t.n = 0;
        await tries.setJSON(key, t);
        return bad("Codename or password is wrong.", 401);
      }
      await tries.delete(key);
      return json({ codename: user.codename }, 200, { "set-cookie": await startSession(user) });
    }

    if (a === "logout" && M === "POST") {
      const m = /brush_s=([a-f0-9]+)/.exec(req.headers.get("cookie") || "");
      if (m) await db("sessions").delete(sha(m[1]));
      return json({ ok: true }, 200, { "set-cookie": "brush_s=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0" });
    }

    const me = await whoAmI(req);
    if (!me) return bad("Sign in first.", 401);

    if (a === "me") return json(me);

    if (a === "invites") {
      if (!b && M === "POST") {
        const id = rid(9);
        await db("invites").setJSON(id, { from: me, exp: Date.now() + INVITE_MS, status: "open" });
        return json({ id });
      }
      const inv = await db("invites").get(b, { type: "json" });
      if (!inv) return bad("This invitation does not exist.", 404);
      if (!c && M === "GET") {
        const status = inv.status === "open" && inv.exp < Date.now() ? "expired" : inv.status;
        return json({ from: inv.from.codename, mine: inv.from.id === me.id, status });
      }
      if (inv.status !== "open" || inv.exp < Date.now()) return bad("This invitation is no longer valid.", 410);
      if (inv.from.id === me.id) return bad("You cannot accept your own invitation.");
      if (c === "decline") {
        await db("invites").setJSON(b, { ...inv, status: "declined" });
        return json({ ok: true });
      }
      if (c === "accept") {
        await db("channels").setJSON(b, { id: b, users: [inv.from, me], created: Date.now() });
        const mine = db("mychan");
        await mine.setJSON(`${me.id}/${b}`, { cid: b, with: inv.from.codename });
        await mine.setJSON(`${inv.from.id}/${b}`, { cid: b, with: me.codename });
        await db("invites").setJSON(b, { ...inv, status: "accepted" });
        return json({ cid: b });
      }
    }

    if (a === "channels") {
      const mine = db("mychan");
      if (!b) {
        const { blobs } = await mine.list({ prefix: me.id + "/" });
        const rows = await Promise.all(blobs.map((x) => mine.get(x.key, { type: "json" })));
        return json({ channels: rows.filter(Boolean) });
      }
      const ch = await memberOf(me, b);
      if (!ch) return bad("No such channel.", 404);
      const other = ch.users.find((u) => u.id !== me.id);
      if (c === "drops" && M === "GET") return json({ with: other.codename, drops: await loadDrops(b) });
      if (c === "drops" && M === "POST") {
        const { kind, iv, ct } = body;
        if (!KINDS.includes(kind) || typeof iv !== "string" || typeof ct !== "string") return bad("Malformed drop.");
        if (ct.length > 3e6 || iv.length > 32) return bad("That drop is too large.", 413);
        const key = `${b}/${String(Date.now()).padStart(14, "0")}-${rid(3)}`;
        await db("drops").setJSON(key, { from: me.codename, kind, iv, ct, exp: Date.now() + DROP_DAYS * DAY });
        return json({ ok: true });
      }
      if (c === "burn" && M === "POST") {
        const store = db("drops");
        const { blobs } = await store.list({ prefix: b + "/" });
        await Promise.all(blobs.map((x) => store.delete(x.key)));
        return json({ ok: true });
      }
    }
    return bad("Not found.", 404);
  } catch (err) {
    console.error(err);
    return bad("Something broke on our side. Try again.", 500);
  }
};

export const config = { path: "/api/*" };
