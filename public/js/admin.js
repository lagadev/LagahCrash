const tgApp = window.Telegram?.WebApp;
tgApp?.ready();
tgApp?.expand();
const initData = tgApp?.initData || "";

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2500);
}

function fmtDate(unixSeconds) {
  if (!unixSeconds) return "–";
  return new Date(unixSeconds * 1000).toLocaleString();
}

async function adminRequest(path, opts = {}) {
  const res = await fetch(`/api/admin${path}`, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Init-Data": initData,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, error: "Bad response" }));
  if (!data.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

function switchView(view) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  if (view === "dashboard") loadDashboard();
  if (view === "game") loadGame();
  if (view === "withdrawals") loadWithdrawals();
  if (view === "users") loadUsers();
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

async function loadDashboard() {
  try {
    const { totalUsers, totalDeposits, totalWithdrawals, pendingWithdrawals } = await adminRequest("/stats");
    document.getElementById("stat-users").textContent = totalUsers;
    document.getElementById("stat-deposits").textContent = Number(totalDeposits).toFixed(2);
    document.getElementById("stat-withdrawals").textContent = Number(totalWithdrawals).toFixed(2);
    document.getElementById("stat-pending").textContent = pendingWithdrawals.length;

    document.getElementById("dash-pending-tbody").innerHTML = pendingWithdrawals.length
      ? pendingWithdrawals
          .map(
            (w) => `<tr>
          <td>${w.username ? "@" + w.username : w.user_id}</td>
          <td>${Number(w.amount).toFixed(2)} ৳</td>
          <td>${Number(w.payout).toFixed(2)} ৳</td>
          <td>${w.wallet || "–"}</td>
          <td style="display:flex;gap:6px">
            <button class="btn success small" onclick="resolveWithdrawal(${w.id}, 'approve')">Approve</button>
            <button class="btn danger small" onclick="resolveWithdrawal(${w.id}, 'reject')">Reject</button>
          </td>
        </tr>`
          )
          .join("")
      : `<tr><td colspan="5"><div class="empty-state">No pending withdrawals</div></td></tr>`;
  } catch (e) {
    toast(e.message);
  }
}

// ---------------------------------------------------------------------------
// Game (as specified)
// ---------------------------------------------------------------------------

async function loadGame() {
  try {
    const { rounds, forcedCrashPoint } = await adminRequest("/game");
    document.getElementById("forced-crash-banner").innerHTML = forcedCrashPoint
      ? `<div class="badge warn" style="margin-bottom:12px">Override active — next round will crash at x${Number(forcedCrashPoint).toFixed(2)}</div>`
      : "";
    document.getElementById("rounds-tbody").innerHTML = rounds.length
      ? rounds
          .map(
            (r) => `<tr>
        <td>#${r.id}</td><td>x${Number(r.crash_point).toFixed(2)}</td><td>${r.total_bets}</td>
        <td>${r.total_wagered} ৳</td><td>${r.total_payout} ৳</td><td style="color:var(--muted)">${fmtDate(r.started_at)}</td>
      </tr>`
          )
          .join("")
      : `<tr><td colspan="6"><div class="empty-state">No rounds yet</div></td></tr>`;
  } catch (e) {
    toast(e.message);
  }
}

async function setForcedCrash() {
  const multiplier = Number(document.getElementById("force-crash-input").value);
  if (!multiplier || multiplier < 1) return toast("Enter a multiplier >= 1");
  try {
    await adminRequest("/game/force-crash", { method: "POST", body: { multiplier } });
    toast(`Next round will crash at x${multiplier}`);
    loadGame();
  } catch (e) {
    toast(e.message);
  }
}

async function clearForcedCrash() {
  try {
    await adminRequest("/game/clear-force-crash", { method: "POST" });
    toast("Override cleared");
    loadGame();
  } catch (e) {
    toast(e.message);
  }
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

async function loadWithdrawals() {
  try {
    const { withdrawals } = await adminRequest("/withdrawals?status=pending");
    document.getElementById("withdrawals-tbody").innerHTML = withdrawals.length
      ? withdrawals
          .map(
            (w) => `<tr>
          <td>${w.username ? "@" + w.username : w.user_id}</td>
          <td>${Number(w.amount).toFixed(2)} ৳</td>
          <td>${Number(w.fee).toFixed(2)} ৳</td>
          <td>${Number(w.payout).toFixed(2)} ৳</td>
          <td>${w.wallet || "–"}</td>
          <td style="color:var(--muted)">${w.created_at}</td>
          <td style="display:flex;gap:6px">
            <button class="btn success small" onclick="resolveWithdrawal(${w.id}, 'approve')">Approve</button>
            <button class="btn danger small" onclick="resolveWithdrawal(${w.id}, 'reject')">Reject</button>
          </td>
        </tr>`
          )
          .join("")
      : `<tr><td colspan="7"><div class="empty-state">No pending withdrawals</div></td></tr>`;
  } catch (e) {
    toast(e.message);
  }
}

async function resolveWithdrawal(id, action) {
  try {
    await adminRequest(`/withdrawals/${id}/${action}`, { method: "POST" });
    toast(action === "approve" ? "Withdrawal approved" : "Withdrawal rejected");
    loadWithdrawals();
    loadDashboard();
  } catch (e) {
    toast(e.message);
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

async function loadUsers() {
  const q = document.getElementById("user-search")?.value?.trim();
  try {
    const { users } = await adminRequest(`/users${q ? `?q=${encodeURIComponent(q)}` : ""}`);
    document.getElementById("users-tbody").innerHTML = users.length
      ? users
          .map(
            (u) => `<tr>
          <td>${u.id}</td>
          <td>${u.username ? "@" + u.username : "–"}</td>
          <td>${Number(u.balance).toFixed(2)} ৳</td>
          <td>${Number(u.total_wagered).toFixed(2)} ৳</td>
          <td>${u.banned ? '<span class="badge bad">Banned</span>' : '<span class="badge ok">Active</span>'}</td>
          <td style="display:flex;gap:6px">
            <button class="btn ghost small" onclick="toggleBan(${u.id}, ${u.banned ? "false" : "true"})">${u.banned ? "Unban" : "Ban"}</button>
          </td>
        </tr>`
          )
          .join("")
      : `<tr><td colspan="6"><div class="empty-state">No users found</div></td></tr>`;
  } catch (e) {
    toast(e.message);
  }
}

async function toggleBan(id, banned) {
  try {
    await adminRequest(`/users/${id}/ban`, { method: "POST", body: { banned } });
    toast(banned ? "User banned" : "User unbanned");
    loadUsers();
  } catch (e) {
    toast(e.message);
  }
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

async function sendBroadcast() {
  const text = document.getElementById("broadcast-text").value.trim();
  if (!text) return toast("Write a message first");
  try {
    const { sent } = await adminRequest("/broadcast", { method: "POST", body: { text } });
    toast(`Sent to ${sent} users`);
    document.getElementById("broadcast-text").value = "";
  } catch (e) {
    toast(e.message);
  }
}

loadDashboard();
