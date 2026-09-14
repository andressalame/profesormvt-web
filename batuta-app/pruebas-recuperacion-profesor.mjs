import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const source = fs.readFileSync(new URL("./worker/index.js", import.meta.url), "utf8");
const forgotStart = source.indexOf('      if (path === "/app/api/t/password/olvide"');
const resetStart = source.indexOf('      if (path === "/app/api/t/password/reset"');
const loginStart = source.indexOf('      if (path === "/app/api/t/login"', resetStart);
assert.ok(forgotStart > 0 && resetStart > forgotStart && loginStart > resetStart);
const forgotBlock = source.slice(forgotStart, resetStart);
const resetBlock = source.slice(resetStart, loginStart);

const tenant = { id: "TENANT", slug: "elevate-test", academia: "Elevate Test", email: "owner@example.test", estado: "activo" };
const teacher = { id: "PROF", tenant_id: tenant.id, email: "teacher@example.test", rol: "profesor", estado: "activo", pass_hash: "old" };

function statement(sql, state) {
  let args = [];
  return {
    bind(...values) { args = values; return this; },
    async first() {
      if (sql === "SELECT * FROM tenants WHERE slug = ?1") return state.tenantBySlug ? tenant : null;
      if (sql === "SELECT * FROM tenants WHERE email = ?1") return state.ownerByEmail ? tenant : null;
      if (sql === "SELECT * FROM tenants WHERE id = ?1") return tenant;
      if (sql === "SELECT slug, estado FROM tenants WHERE id = ?1") return { slug: tenant.slug, estado: tenant.estado };
      if (sql === "SELECT * FROM reset_tokens WHERE token_hash = ?1") return state.resetRow || null;
      if (sql.startsWith("SELECT id, tenant_id, estado FROM profesores")) return state.teacherExists ? teacher : null;
      throw new Error("Lectura inesperada: " + sql);
    },
    async all() {
      if (sql.includes("FROM profesores p JOIN tenants t")) return { results: state.teacherMatches || [] };
      throw new Error("Lista inesperada: " + sql);
    },
    async run() {
      state.runs.push({ sql, args });
      if (sql.startsWith("UPDATE reset_tokens SET usado = 1")) return { meta: { changes: state.claimChanges ?? 1 } };
      return { meta: { changes: 1 } };
    },
    _record() { return { sql, args }; },
  };
}

async function runForgot({ email = teacher.email, slug = tenant.slug, teacherMatches = [teacher], tenantBySlug = true, ownerByEmail = false } = {}) {
  const state = { tenantBySlug, ownerByEmail, teacherMatches, runs: [], batches: [], mails: [] };
  const DB = {
    prepare(sql) { return statement(sql, state); },
    async batch(items) { state.batches.push(items.map(item => item._record())); },
  };
  const box = {
    env: { DB },
    path: "/app/api/t/password/olvide",
    request: { method: "POST", json: async () => ({ email, slug }) },
    clientIp: () => "",
    chatbotPasoTope: async () => false,
    emailOk: value => value.includes("@"),
    ensureMultiprofesorSchema: async () => {},
    randHex: () => "a".repeat(64),
    sha256Hex: async () => "hash",
    enviarCorreo: async (_env, mail) => { state.mails.push(mail); },
    MARCA: { dominio: "https://batuta.test" },
    json: (data, status = 200) => ({ data, status }),
    Date,
  };
  const result = await vm.runInNewContext("(async()=>{" + forgotBlock + "})()", box);
  return { result, state };
}

async function runReset({ actor = "P:PROF", used = 0, claimChanges = 1, teacherExists = true } = {}) {
  const state = {
    teacherExists,
    claimChanges,
    resetRow: { token_hash: "hash", tenant_id: tenant.id, cuenta_id: actor, expira: new Date(Date.now() + 60_000).toISOString(), usado: used },
    runs: [],
    batches: [],
    sessions: [],
  };
  const DB = {
    prepare(sql) { return statement(sql, state); },
    async batch(items) { state.batches.push(items.map(item => item._record())); },
  };
  const box = {
    env: { DB },
    path: "/app/api/t/password/reset",
    request: { method: "POST", json: async () => ({ token: "a".repeat(64), nueva: "nueva-segura" }) },
    sha256Hex: async () => "hash",
    randHex: () => "salt",
    hashPass: async pass => "hashed:" + pass,
    asegurarDueno: async () => ({ id: "OWNER" }),
    crearSesion: async (_env, id) => { state.sessions.push(id); return "session"; },
    json: (data, status = 200) => ({ data, status }),
    Date,
  };
  const result = await vm.runInNewContext("(async()=>{" + resetBlock + "})()", box);
  return { result, state };
}

const checks = [];
async function test(name, fn) {
  await fn();
  checks.push(name);
  console.log("PASS " + name);
}

await test("la pantalla de ingreso ofrece recuperación y conserva el slug", async () => {
  assert.match(source, /\/app\/recuperar\" \+ \(slug \? \"\?slug=\"/);
  assert.match(source, /¿Olvidaste tu contraseña\?/);
});

await test("un profesor recibe un enlace de 30 minutos para su academia", async () => {
  const { result, state } = await runForgot();
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(state.mails.length, 1);
  assert.equal(state.mails[0].to, teacher.email);
  assert.match(state.mails[0].text, /\/app\/restablecer\?token=/);
  assert.equal(state.batches.length, 1);
  assert.equal(state.batches[0][1].args[2], "P:PROF");
});

await test("un correo desconocido recibe la misma respuesta sin correo ni token", async () => {
  const { result, state } = await runForgot({ tenantBySlug: false, teacherMatches: [] });
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(state.mails.length, 0);
  assert.equal(state.batches.length, 0);
});

await test("sin slug no elige en secreto entre dos academias del mismo profesor", async () => {
  const { state } = await runForgot({ slug: "", tenantBySlug: false, teacherMatches: [teacher, { ...teacher, id: "PROF2" }] });
  assert.equal(state.mails.length, 0);
});

await test("el reset del profesor reclama el token una vez, cambia solo profesores y cierra sus sesiones", async () => {
  const { result, state } = await runReset();
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.token, "session");
  assert.equal(result.data.slug, tenant.slug);
  assert.deepEqual(state.sessions, ["P:PROF"]);
  const sql = state.batches.flat().map(item => item.sql).join("\n");
  assert.match(sql, /UPDATE profesores SET pass_hash/);
  assert.match(sql, /DELETE FROM sesiones WHERE cuenta_id = \?1/);
  assert.doesNotMatch(sql, /UPDATE tenants SET pass_hash/);
});

await test("un token ya usado o perdido en una carrera no cambia contraseñas", async () => {
  assert.equal((await runReset({ used: 1 })).result.status, 400);
  const raced = await runReset({ claimChanges: 0 });
  assert.equal(raced.result.status, 400);
  assert.equal(raced.state.batches.length, 0);
});

await test("el reset del dueño sincroniza tenant y fila de dueño", async () => {
  const { result, state } = await runReset({ actor: "T:TENANT" });
  assert.equal(result.status, 200);
  const sql = state.batches.flat().map(item => item.sql).join("\n");
  assert.match(sql, /UPDATE tenants SET pass_hash/);
  assert.match(sql, /UPDATE profesores SET pass_hash/);
  assert.deepEqual(state.sessions, ["T:TENANT"]);
});

console.log(checks.length + " escenarios de recuperación pasaron; producción intacta");
