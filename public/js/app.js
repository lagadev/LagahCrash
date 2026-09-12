(function () {
  const tgApp = window.Telegram?.WebApp;
  tgApp?.ready();
  tgApp?.expand();

  const initData = tgApp?.initData || "";
  const user = tgApp?.initDataUnsafe?.user;

  const els = {
    connDot: document.getElementById("conn-dot"),
    balanceAmt: document.getElementById("balance-amt"),
    avatar: document.getElementById("avatar"),
    historyRow: document.getElementById("history-row"),
    connectingOverlay: document.getElementById("connecting-overlay"),
    rocket: document.getElementById("rocket"),
    crashEmoji: document.getElementById("crash-emoji"),
    countdownWrap: document.getElementById("countdown-wrap"),
    countdownNum: document.getElementById("countdown-num"),
    multiplierEl: document.getElementById("multiplier-el"),
    playersCount: document.getElementById("players-count"),
    roundHash: document.getElementById("round-hash"),
    betList: document.getElementById("bet-list"),
    amtInput: document.getElementById("amt-input"),
    amtMinus: document.getElementById("amt-minus"),
    amtPlus: document.getElementById("amt-plus"),
    autostopToggle: document.getElementById("autostop-toggle"),
    autostopPresets: document.getElementById("autostop-presets"),
    autostopInput: document.getElementById("autostop-input"),
    betBtn: document.getElementById("bet-btn"),
    depositBtn: document.getElementById("deposit-btn"),
    toast: document.getElementById("toast"),
  };

  let ws = null;
  let phase = "waiting";
  let myBetPlaced = false;
  let myCashedOut = false;
  let autoStopOn = false;
  let balance = 0;
  let reconnectDelay = 1000;

  if (user) {
    els.avatar.textContent = (user.first_name || "?").slice(0, 1).toUpperCase();
    if (user.photo_url) {
      els.avatar.style.backgroundImage = `url(${user.photo_url})`;
      els.avatar.textContent = "";
    }
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    setTimeout(() => els.toast.classList.remove("show"), 2200);
  }

  function fmtBdt(n) {
    return `৳${Number(n || 0).toFixed(2)}`;
  }

  function setConnected(isConnected) {
    els.connDot.style.background = isConnected ? "var(--green)" : "var(--red)";
    els.connectingOverlay.classList.toggle("hidden", isConnected);
  }

  async function loadInitialBalance() {
    try {
      const res = await fetch(`/api/game/balance`, { headers: { "X-Telegram-Init-Data": initData } });
      const data = await res.json();
      if (data.ok) {
        balance = data.balance;
        els.balanceAmt.textContent = balance.toFixed(2);
      }
    } catch {}
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/api/game/ws?initData=${encodeURIComponent(initData)}`);

    ws.addEventListener("open", () => {
      setConnected(true);
      reconnectDelay = 1000;
    });

    ws.addEventListener("close", () => {
      setConnected(false);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
    });

    ws.addEventListener("error", () => ws.close());

    ws.addEventListener("message", (evt) => {
      const msg = JSON.parse(evt.data);
      handleMessage(msg);
    });
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "state":
      case "round_start":
      case "crash":
        renderState(msg.payload);
        break;
      case "countdown":
        renderCountdown(msg.payload.countdownSeconds);
        break;
      case "tick":
        renderMultiplier(msg.payload.multiplier, "live");
        break;
      case "balance":
        balance = msg.payload;
        els.balanceAmt.textContent = balance.toFixed(2);
        break;
      case "cashed_out":
        if (user && msg.payload.userId === user.id) {
          myCashedOut = true;
          toast(`Cashed out at x${Number(msg.payload.multiplier).toFixed(2)}! 🎉`);
        }
        break;
      case "error":
        toast(msg.payload);
        break;
    }
  }

  function renderCountdown(seconds) {
    phase = "waiting";
    els.countdownWrap.style.display = "block";
    els.multiplierEl.style.display = "none";
    els.rocket.style.display = "none";
    els.crashEmoji.style.display = "none";
    els.countdownNum.textContent = seconds;
    updateBetButton();
  }

  function renderMultiplier(mult, mode) {
    els.countdownWrap.style.display = "none";
    els.multiplierEl.style.display = "block";
    els.multiplierEl.className = `crash-multiplier ${mode}`;
    els.multiplierEl.textContent = `${Number(mult).toFixed(2)}x`;
    els.rocket.style.display = mode === "live" ? "flex" : "none";
    els.crashEmoji.style.display = mode === "crashed" ? "flex" : "none";
  }

  function renderState(view) {
    phase = view.phase;

    if (view.phase === "waiting") {
      renderCountdown(view.countdownSeconds);
      myBetPlaced = view.bets.some((b) => user && b.userId === user.id);
      myCashedOut = false;
    } else if (view.phase === "running") {
      renderMultiplier(view.multiplier, "live");
      const mine = view.bets.find((b) => user && b.userId === user.id);
      myBetPlaced = !!mine;
      myCashedOut = mine ? mine.status === "won" : false;
    } else if (view.phase === "crashed") {
      renderMultiplier(view.crashPoint ?? view.multiplier, "crashed");
    }

    els.roundHash.title = view.serverHash || "";
    els.roundHash.textContent = view.serverHash ? `hash: ${view.serverHash.slice(0, 8)}…` : "";
    els.playersCount.textContent = `Players (${view.bets.length})`;
    renderHistory(view.history || []);
    renderBets(view.bets || []);
    updateBetButton();
  }

  function chipClass(v) {
    if (v >= 5) return "chip high";
    if (v >= 2) return "chip mid";
    return "chip";
  }

  function renderHistory(history) {
    els.historyRow.innerHTML = "";
    // Live status pill first (mirrors the reference UI: shows "Waiting" or the live multiplier).
    const live = document.createElement("div");
    live.className = "chip current";
    if (phase === "waiting") live.textContent = "Waiting";
    else if (phase === "running") live.textContent = `x${els.multiplierEl.textContent.replace("x", "")}`;
    else live.textContent = els.multiplierEl.textContent;
    els.historyRow.appendChild(live);

    history.forEach((v) => {
      const chip = document.createElement("div");
      chip.className = chipClass(v);
      chip.textContent = `x${Number(v).toFixed(2)}`;
      els.historyRow.appendChild(chip);
    });
  }

  function renderBets(bets) {
    if (!bets.length) {
      els.betList.innerHTML = `<div class="no-bets">No bets yet this round</div>`;
      return;
    }
    els.betList.innerHTML = bets
      .map((b) => {
        const initial = (b.username || "?").slice(0, 1).toUpperCase();
        const avatarStyle = b.photoUrl ? `style="background-image:url(${b.photoUrl})"` : "";
        const multClass = b.status === "won" ? "win" : b.status === "lost" ? "lost" : "pending";
        const multText = b.status === "lost" ? "x0.00" : `x${Number(b.multiplier).toFixed(2)}`;
        const rowFlash = b.status === "won" ? "win-flash" : b.status === "lost" ? "lost-flash" : "";
        return `
        <div class="bet-row ${rowFlash}">
          <div class="avatar" ${avatarStyle}>${b.photoUrl ? "" : initial}</div>
          <div class="who">
            <div class="name">${escapeHtml(b.username || "player")}</div>
            <div class="amt"><span class="star-ic"><img src="/assets/bdt.png" /></span>${Number(b.amount).toFixed(2)}</div>
          </div>
          <div class="grow-col">
            <span class="mult ${multClass}">${multText}</span>
            <span class="grow-amt"><span class="star-ic"><img src="/assets/bdt.png" /></span>${Number(b.winningsNow).toFixed(2)}</span>
          </div>
        </div>`;
      })
      .join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function updateBetButton() {
    const amount = Number(els.amtInput.value) || 0;
    if (phase === "waiting") {
      els.betBtn.className = "btn-primary";
      els.betBtn.disabled = myBetPlaced;
      els.betBtn.textContent = myBetPlaced ? "Bet placed — waiting…" : `Bet ৳ ${amount}`;
    } else if (phase === "running") {
      if (myBetPlaced && !myCashedOut) {
        els.betBtn.className = "btn-primary cashout";
        els.betBtn.disabled = false;
        const live = Number(els.multiplierEl.textContent.replace("x", "")) || 1;
        els.betBtn.textContent = `Cash Out ৳ ${(amount * live).toFixed(2)}`;
      } else {
        els.betBtn.className = "btn-primary";
        els.betBtn.disabled = true;
        els.betBtn.textContent = myCashedOut ? "Cashed out ✅" : "Round in progress…";
      }
    } else {
      els.betBtn.className = "btn-primary";
      els.betBtn.disabled = true;
      els.betBtn.textContent = "Round crashed 💥";
    }
  }

  // ---- Amount stepper ----
  els.amtMinus.addEventListener("click", () => {
    els.amtInput.value = Math.max(1, Number(els.amtInput.value) - 1);
    updateBetButton();
  });
  els.amtPlus.addEventListener("click", () => {
    els.amtInput.value = Number(els.amtInput.value) + 1;
    updateBetButton();
  });
  els.amtInput.addEventListener("input", updateBetButton);

  // ---- Auto-stop toggle + presets ----
  els.autostopToggle.addEventListener("click", () => {
    autoStopOn = !autoStopOn;
    els.autostopToggle.classList.toggle("checked", autoStopOn);
    els.autostopPresets.style.display = autoStopOn ? "flex" : "none";
  });
  els.autostopPresets.querySelectorAll("button[data-mult]").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.autostopInput.value = btn.dataset.mult;
    });
  });

  // ---- Bet / Cashout ----
  els.betBtn.addEventListener("click", () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return toast("Not connected yet…");

    if (phase === "waiting" && !myBetPlaced) {
      const amount = Math.round(Number(els.amtInput.value));
      if (!amount || amount < 1) return toast("Enter a valid bet amount");
      const autoCashoutAt = autoStopOn ? Number(els.autostopInput.value) : null;
      ws.send(JSON.stringify({ type: "bet", amount, autoCashoutAt }));
    } else if (phase === "running" && myBetPlaced && !myCashedOut) {
      ws.send(JSON.stringify({ type: "cashout" }));
    }
  });

  // ---- Deposit: hands off to the bot chat (deposit amount + payment link happen there) ----
  els.depositBtn.addEventListener("click", () => {
    if (tgApp?.sendData) {
      tgApp.sendData(JSON.stringify({ action: "deposit" }));
    } else {
      toast("Open the bot chat → Profile → Deposit");
    }
  });

  loadInitialBalance();
  connect();
})();
