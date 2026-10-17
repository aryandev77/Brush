import { newPasskey, deriveKey, seal, unseal, shrinkImage } from "/crypto.js";

const app = document.getElementById("app");
let me = null;
let timer = null;

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  e.append(...kids.filter((x) => x !== null && x !== undefined && x !== false));
  return e;
};

async function api(path, method = "GET", body) {
  const r = await fetch("/api/" + path, {
    method,
    headers: { "content-type": "application/json", "x-brush": "1" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Request failed.");
  return d;
}

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  if (m < 1440) return Math.round(m / 60) + " h ago";
  return Math.round(m / 1440) + " d ago";
};
const keyStore = (cid) => "brush.key." + cid;
const show = (...nodes) => { clearInterval(timer); app.replaceChildren(h("div", { class: "wrap" }, ...nodes)); };
const top = () =>
  h("header", { class: "top" },
    h("a", { class: "mark", href: "#/" }, "BRUSH"),
    me ? h("span", { class: "mono mute" }, me.codename + "  ",
      h("button", { class: "link", onclick: async () => { await api("logout", "POST"); me = null; route(); } }, "Sign out")) : null);

function authView(note) {
  let signup = true;
  const err = h("p", { class: "err" });
  const name = h("input", { id: "n", autocomplete: "username", required: "" });
  const pass = h("input", { id: "p", type: "password", autocomplete: "current-password", required: "" });
  const go = h("button", { class: "stamp" }, "Create codename");
  const swap = h("button", { class: "link", type: "button" }, "I already have a codename");
  const form = h("form", {},
    h("label", { for: "n" }, "Codename"), name,
    h("label", { for: "p" }, "Password, 10 characters or more"), pass,
    err, go, swap);
  swap.onclick = () => {
    signup = !signup;
    go.textContent = signup ? "Create codename" : "Sign in";
    swap.textContent = signup ? "I already have a codename" : "I need a codename";
  };
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    try {
      await api(signup ? "signup" : "login", "POST", { codename: name.value.trim(), password: pass.value });
      me = await api("me");
      route();
    } catch (e) { err.textContent = e.message; }
  };
  show(top(), h("h1", {}, "Leave it. Pick it up."),
    h("p", { class: "mute" }, note || "Private drops between people you trust. No email, no real names. You must be 16 or older to use Brush."),
    form);
}

async function homeView() {
  const { channels } = await api("channels");
  const out = h("div");
  const add = h("button", {
    onclick: async () => {
      const { id } = await api("invites", "POST");
      const key = newPasskey();
      localStorage.setItem(keyStore(id), key);
      const link = `${location.origin}/#/join/${id}.${key}`;
      const copy = h("button", { onclick: async () => { await navigator.clipboard.writeText(link); copy.textContent = "Copied"; } }, "Copy link");
      out.replaceChildren(h("div", { class: "panel stamped" },
        h("p", { class: "mono" }, link),
        h("p", { class: "mute" }, "Send this on WhatsApp or anywhere else. It works once and expires in 48 hours. The part after the # never reaches our server, so keep the link between you two."),
        copy,
        navigator.share ? h("button", { onclick: () => navigator.share({ text: "Pick this up:", url: link }) }, "Share") : null));
    },
  }, "Add spy");
  show(top(),
    h("h1", {}, "Your spies"),
    channels.length
      ? h("ul", { class: "list" }, ...channels.map((c) => h("li", {}, h("a", { href: "#/c/" + c.cid }, c.with))))
      : h("p", { class: "mute" }, "No spies yet. Quiet is good, but a drop needs two people."),
    add, out);
}

async function joinView(id) {
  const inv = await api("invites/" + id).catch((e) => ({ error: e.message }));
  const err = h("p", { class: "err" }, inv.error || "");
  if (inv.error || inv.mine || inv.status !== "open") {
    return show(top(), h("h1", {}, inv.mine ? "This is your own invitation" : "This invitation is closed"),
      h("p", { class: "mute" }, inv.mine ? "Send the link to the person you want to add." : "It was used, declined or expired. Ask for a new link."), err,
      h("a", { class: "btn", href: "#/" }, "Back to your spies"));
  }
  const key = sessionStorage.getItem("brush.pending.key");
  show(top(), h("h1", {}, `Agent ${inv.from} sent you an invitation.`),
    h("p", { class: "mute" }, "Accept and the two of you share a private channel. What you leave there is locked with a key only you two hold."), err,
    h("button", { class: "stamp", onclick: async () => {
      try {
        localStorage.setItem(keyStore(id), key);
        sessionStorage.removeItem("brush.pending.key");
        const { cid } = await api(`invites/${id}/accept`, "POST");
        location.hash = "#/c/" + cid;
      } catch (e) { err.textContent = e.message; }
    } }, "Accept"),
    h("button", { onclick: async () => { await api(`invites/${id}/decline`, "POST"); location.hash = "#/"; } }, "Decline"));
}

async function channelView(cid) {
  let cryptoKey = null;
  const stored = localStorage.getItem(keyStore(cid));
  const list = h("div");
  const err = h("p", { class: "err" });
  let who = "";

  async function refresh() {
    try {
      const d = await api(`channels/${cid}/drops`);
      who = d.with;
      title.textContent = who;
      const items = await Promise.all(d.drops.map(async (x) => {
        let body;
        try {
          const p = await unseal(cryptoKey, x);
          body = x.kind === "photo" ? h("img", { src: p.img, alt: "Photo drop" })
            : x.kind === "code" ? h("pre", {}, p.text) : h("p", {}, p.text);
        } catch { body = h("p", { class: "err" }, "This one will not open. Wrong passkey?"); }
        return h("div", { class: "drop" }, h("div", { class: "meta" }, `${x.from}, ${ago(+x.id.split("/")[1].split("-")[0])}, ${x.kind}`), body);
      }));
      list.replaceChildren(...(items.length ? items : [h("p", { class: "mute" }, "Nothing here yet. Quiet is good.")]));
    } catch (e) { err.textContent = e.message; }
  }

  const title = h("h1", {}, "Channel");
  const text = h("textarea", { id: "t", placeholder: "Write a note or paste code" });
  const kind = h("select", { "aria-label": "Type" }, h("option", { value: "note" }, "Note"), h("option", { value: "code" }, "Code"));
  const file = h("input", { type: "file", accept: "image/*", hidden: "" });
  const send = async (kindName, payload) => {
    err.textContent = "";
    try {
      await api(`channels/${cid}/drops`, "POST", { kind: kindName, ...(await seal(cryptoKey, payload)) });
      text.value = "";
      await refresh();
    } catch (e) { err.textContent = e.message; }
  };
  file.onchange = async () => { if (file.files[0]) await send("photo", { img: await shrinkImage(file.files[0]) }); file.value = ""; };

  const start = async (pass) => {
    cryptoKey = await deriveKey(pass, cid);
    const ui = [top(), title,
      h("label", { for: "t" }, "Leave a drop"), text,
      h("div", { class: "row" }, kind,
        h("button", { class: "stamp", onclick: () => text.value.trim() && send(kind.value, { text: text.value }) }, "Leave drop"),
        h("button", { onclick: () => file.click() }, "Add photo"), file),
      err, list,
      h("p", { class: "mute mono" }, "Drops burn after 7 days. "),
      h("button", { onclick: async () => { if (confirm("Burn every drop in this channel now?")) { await api(`channels/${cid}/burn`, "POST"); refresh(); } } }, "Burn now")];
    show(...ui);
    await refresh();
    timer = setInterval(() => !document.hidden && refresh(), 15000);
  };

  if (stored) return start(stored);
  const field = h("input", { id: "k", placeholder: "Paste the key from your link", required: "" });
  const form = h("form", {}, h("label", { for: "k" }, "Passkey"), field, h("button", { class: "stamp" }, "Unlock"));
  form.onsubmit = (e) => { e.preventDefault(); localStorage.setItem(keyStore(cid), field.value.trim()); channelView(cid); };
  show(top(), h("h1", {}, "This channel is locked on this device"),
    h("p", { class: "mute" }, "The passkey lives only in the browser that accepted the invitation. Enter it to read here. If both of you lose it, the drops cannot be recovered."), form);
}

async function route() {
  const hash = location.hash;
  const join = /^#\/join\/([a-f0-9]+)\.(.+)$/.exec(hash);
  if (join) {
    sessionStorage.setItem("brush.pending.key", join[2]);
    history.replaceState(null, "", "#/join/" + join[1]); // pull the key out of the address bar
  }
  const id = join ? join[1] : (/^#\/join\/([a-f0-9]+)$/.exec(hash) || [])[1];
  if (!me) return authView(id ? "You have been handed an invitation. Make a codename to open it." : "");
  if (id) return joinView(id);
  const ch = /^#\/c\/([a-f0-9]+)$/.exec(hash);
  if (ch) return channelView(ch[1]);
  return homeView();
}

window.addEventListener("hashchange", route);
api("me").then((u) => (me = u)).catch(() => {}).finally(route);
