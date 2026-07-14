/**
 * NotebookLM 一括削除 - content script
 *
 * NotebookLM は Angular 製 SPA であり、DOM 構造やクラス名は頻繁に変わる。
 * そのため実際にDOMへアクセスするセレクタ・ラベル文字列は
 * すべて SELECTORS にまとめてある。動かない場合はまず README を見て
 * ここを実際のDOMに合わせて調整すること。
 */
(function () {
  "use strict";

  // ------------------------------------------------------------------
  // SELECTORS: 実DOMに合わせて調整する対象はすべてここに集約する
  // ------------------------------------------------------------------
  const SELECTORS = {
    // ホーム画面上の「ノートブックカード」候補セレクタ（上から順に試す）
    card: [
      "project-button",
      "[role='button'][class*='project']",
      "a[href*='/notebook/']",
      "[data-test-id='project-button']",
      "mat-card[role='button']",
      "[class*='notebook-card']",
    ],

    // カード内の「その他の操作」(3点メニュー)ボタン候補
    // 実DOM確認済み(2026-07): button.project-button-more,
    // aria-label「プロジェクトの操作メニュー」/ dialoglabel "Project Actions Menu"
    moreButton: {
      selectors: [
        "button.project-button-more",
        "button[aria-label]",
        "[role='button'][aria-label]",
        "button.mat-mdc-icon-button",
      ],
      labels: [
        "プロジェクトの操作メニュー",
        "Project Actions Menu",
        "その他の操作",
        "その他",
        "More options",
        "More actions",
      ],
    },

    // 3点メニューを開いた後に表示されるメニュー(popup)自体の候補
    menuPopup: ["[role='menu']", ".mat-mdc-menu-panel", ".cdk-overlay-pane [role='menu']"],

    // メニュー内の「削除」項目候補
    deleteMenuItem: {
      selectors: ["[role='menuitem']", "button[role='menuitem']", ".mat-mdc-menu-item"],
      labels: ["削除", "Delete", "Remove"],
    },

    // 削除確認ダイアログ自体の候補
    // 実DOM確認済み: mat-dialog-container[role='dialog']
    confirmDialog: ["mat-dialog-container", "[role='dialog']", ".mat-mdc-dialog-container"],

    // 確認ダイアログ内の「削除」実行ボタン候補
    // 実DOM確認済み: 日本語UIでも確定ボタンのラベルは「Delete」(英語)、
    // class に primary-button が付く（キャンセル側は tertiary-button）
    confirmDeleteButton: {
      selectors: ["button.primary-button", "button", "[role='button']"],
      labels: ["Delete", "削除", "はい", "OK", "確認"],
    },

    // カードのタイトル文字列取得候補（進捗表示用、無くても可）
    // 実DOM確認済み: span.project-button-title
    cardTitle: [".project-button-title", "[class*='title']", "h2", "h3", "span"],
  };

  const STATE = {
    active: false,
    selected: new Set(), // 選択中のノートブックID（要素参照だとSPA再描画で無効になる）
    running: false,
  };

  // 削除キューの永続化キー。NotebookLMは削除を繰り返すと
  // ページのリロードが入ることがあるため、残りのIDを sessionStorage に
  // 保存しておき、リロード後に自動で再開する。
  const QUEUE_KEY = "nlm-bulk-delete-queue";

  function loadQueue() {
    try {
      return JSON.parse(sessionStorage.getItem(QUEUE_KEY)) || [];
    } catch (e) {
      return [];
    }
  }

  function saveQueue(ids) {
    try {
      if (ids.length) sessionStorage.setItem(QUEUE_KEY, JSON.stringify(ids));
      else sessionStorage.removeItem(QUEUE_KEY);
    } catch (e) {
      /* storage不可でも動作は継続 */
    }
  }

  let panelEl = null;
  let toggleBtnEl = null;

  // ------------------------------------------------------------------
  // ユーティリティ
  // ------------------------------------------------------------------

  function queryAllUnique(selectorList, root = document) {
    const result = [];
    const seen = new Set();
    for (const sel of selectorList) {
      let nodes;
      try {
        nodes = root.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      nodes.forEach((n) => {
        if (!seen.has(n)) {
          seen.add(n);
          result.push(n);
        }
      });
    }
    return result;
  }

  function normalize(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function elementLabelText(el) {
    return normalize(
      el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        el.textContent ||
        ""
    );
  }

  function matchesLabel(el, labels) {
    const text = elementLabelText(el);
    if (!text) return false;
    return labels.some((label) => text === label || text.includes(label));
  }

  function findByLabel(selectorList, labels, root = document) {
    const candidates = queryAllUnique(selectorList, root);
    return candidates.find((el) => matchesLabel(el, labels)) || null;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  /**
   * 条件が満たされるまで待つ。MutationObserver + ポーリングの併用。
   * @param {() => any} conditionFn 満たされたら truthy な値を返す
   * @param {number} timeoutMs
   */
  function waitFor(conditionFn, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const immediate = conditionFn();
      if (immediate) {
        resolve(immediate);
        return;
      }

      let settled = false;
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearInterval(intervalId);
        clearTimeout(timeoutId);
        if (error) reject(error);
        else resolve(value);
      };

      const observer = new MutationObserver(() => {
        const value = conditionFn();
        if (value) finish(value);
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });

      const intervalId = setInterval(() => {
        const value = conditionFn();
        if (value) finish(value);
      }, 150);

      const timeoutId = setTimeout(() => {
        finish(null, new Error("timeout"));
      }, timeoutMs);
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function findCards() {
    const all = queryAllUnique(SELECTORS.card).filter((el) => isVisible(el));
    // 複数のセレクタ候補が同じカードの外側/内側要素に同時ヒットした場合、
    // 最も外側の要素だけをカードとして扱う（二重チェックボックス防止）
    return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
  }

  function getCardTitle(card) {
    for (const sel of SELECTORS.cardTitle) {
      const el = card.querySelector(sel);
      const text = normalize(el && el.textContent);
      if (text) return text;
    }
    return normalize(elementLabelText(card)) || "(タイトル不明)";
  }

  /** カードからノートブックID(URLの /notebook/<id>)を取り出す */
  function getCardId(card) {
    const link = card.matches("a[href*='/notebook/']")
      ? card
      : card.querySelector("a[href*='/notebook/']");
    const href = link && link.getAttribute("href");
    const m = href && href.match(/\/notebook\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  function findCardById(id) {
    return findCards().find((c) => getCardId(c) === id) || null;
  }

  // ------------------------------------------------------------------
  // UI構築
  // ------------------------------------------------------------------

  function createToggleButton() {
    const btn = document.createElement("button");
    btn.id = "nlm-bulk-delete-toggle";
    btn.className = "nlm-bulk-toggle-btn";
    btn.textContent = "一括削除モード";
    btn.addEventListener("click", () => {
      setActive(!STATE.active);
    });
    document.body.appendChild(btn);
    return btn;
  }

  function createPanel() {
    const panel = document.createElement("div");
    panel.id = "nlm-bulk-delete-panel";
    panel.className = "nlm-bulk-panel";

    // NotebookLM は Trusted Types (CSP) を強制しており innerHTML は例外になるため、
    // パネルは DOM API で組み立てる
    const row = document.createElement("div");
    row.className = "nlm-bulk-panel-row";

    const count = document.createElement("span");
    count.className = "nlm-bulk-count";
    count.textContent = "選択: 0件";
    row.appendChild(count);

    const mkButton = (cls, text) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.textContent = text;
      row.appendChild(b);
      return b;
    };
    mkButton("nlm-bulk-select-all", "全選択");
    mkButton("nlm-bulk-select-none", "全解除");
    mkButton("nlm-bulk-execute", "選択したN件を削除");
    mkButton("nlm-bulk-close", "閉じる");

    const status = document.createElement("div");
    status.className = "nlm-bulk-status";
    status.setAttribute("aria-live", "polite");

    panel.appendChild(row);
    panel.appendChild(status);
    document.body.appendChild(panel);

    panel.querySelector(".nlm-bulk-select-all").addEventListener("click", selectAllCards);
    panel.querySelector(".nlm-bulk-select-none").addEventListener("click", deselectAllCards);
    panel.querySelector(".nlm-bulk-execute").addEventListener("click", onExecuteDeleteClick);
    panel.querySelector(".nlm-bulk-close").addEventListener("click", () => setActive(false));

    return panel;
  }

  function updatePanel() {
    if (!panelEl) return;
    const count = STATE.selected.size;
    // 値が変わったときだけ書き込む（無変更の textContent 代入でも
    // MutationObserver が発火し、無限ループ→ページフリーズの原因になる）
    const setText = (el, text) => {
      if (el.textContent !== text) el.textContent = text;
    };
    setText(panelEl.querySelector(".nlm-bulk-count"), `選択: ${count}件`);
    const execBtn = panelEl.querySelector(".nlm-bulk-execute");
    setText(execBtn, `選択した${count}件を削除`);
    const disabled = count === 0 || STATE.running;
    if (execBtn.disabled !== disabled) execBtn.disabled = disabled;
  }

  function setStatus(text, isError) {
    if (!panelEl) return;
    const statusEl = panelEl.querySelector(".nlm-bulk-status");
    statusEl.textContent = text || "";
    statusEl.classList.toggle("nlm-bulk-status-error", !!isError);
  }

  function attachCheckbox(card) {
    const id = getCardId(card);
    const existing = card.querySelector(":scope > .nlm-bulk-checkbox-overlay input");
    if (existing) {
      // SPA再描画後もID基準で選択状態を復元する
      const want = !!(id && STATE.selected.has(id));
      if (existing.checked !== want) existing.checked = want;
      return;
    }
    card.classList.add("nlm-bulk-card-relative");

    const overlay = document.createElement("label");
    overlay.className = "nlm-bulk-checkbox-overlay";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!(id && STATE.selected.has(id));
    checkbox.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    checkbox.addEventListener("change", (e) => {
      e.stopPropagation();
      const cardId = getCardId(card);
      if (!cardId) return;
      if (checkbox.checked) STATE.selected.add(cardId);
      else STATE.selected.delete(cardId);
      updatePanel();
    });

    overlay.appendChild(checkbox);
    card.appendChild(overlay);
  }

  function detachCheckbox(card) {
    const overlay = card.querySelector(":scope > .nlm-bulk-checkbox-overlay");
    if (overlay) overlay.remove();
    card.classList.remove("nlm-bulk-card-relative");
  }

  function decorateCards() {
    const cards = findCards();
    if (cards.length === 0) {
      setStatus(
        "ノートブックカードが見つかりませんでした。SELECTORS.card の調整が必要な可能性があります。",
        true
      );
    }
    cards.forEach(attachCheckbox);
  }

  function removeDecorations() {
    findCards().forEach(detachCheckbox);
    STATE.selected.clear();
  }

  function selectAllCards() {
    findCards().forEach((card) => {
      const id = getCardId(card);
      if (id) STATE.selected.add(id);
      const checkbox = card.querySelector(".nlm-bulk-checkbox-overlay input");
      if (checkbox) checkbox.checked = true;
    });
    updatePanel();
  }

  function deselectAllCards() {
    STATE.selected.clear();
    findCards().forEach((card) => {
      const checkbox = card.querySelector(".nlm-bulk-checkbox-overlay input");
      if (checkbox) checkbox.checked = false;
    });
    updatePanel();
  }

  function setActive(active) {
    STATE.active = active;
    if (toggleBtnEl) {
      toggleBtnEl.classList.toggle("nlm-bulk-toggle-active", active);
      toggleBtnEl.textContent = active ? "一括削除モード終了" : "一括削除モード";
    }
    if (active) {
      if (!panelEl) panelEl = createPanel();
      panelEl.style.display = "";
      decorateCards();
      updatePanel();
      setStatus("");
    } else {
      removeDecorations();
      if (panelEl) panelEl.style.display = "none";
    }
  }

  // ------------------------------------------------------------------
  // 削除実行フロー
  // ------------------------------------------------------------------

  async function deleteOneCard(card, index, total) {
    const title = getCardTitle(card);
    setStatus(`(${index}/${total}) 「${title}」を削除中...`);

    const moreBtn = findByLabel(SELECTORS.moreButton.selectors, SELECTORS.moreButton.labels, card);
    if (!moreBtn) {
      throw new Error(`「その他の操作」ボタンが見つかりません（カード: ${title}）。SELECTORS.moreButton の調整が必要です。`);
    }
    moreBtn.click();

    const menuPopup = await waitFor(() => {
      const popup = queryAllUnique(SELECTORS.menuPopup).find(isVisible);
      return popup || null;
    }).catch(() => {
      throw new Error(`メニューが開きませんでした（カード: ${title}）。SELECTORS.menuPopup の調整が必要です。`);
    });

    const deleteItem = await waitFor(() => {
      return findByLabel(
        SELECTORS.deleteMenuItem.selectors,
        SELECTORS.deleteMenuItem.labels,
        menuPopup || document
      );
    }).catch(() => {
      throw new Error(`メニュー内の「削除」項目が見つかりません（カード: ${title}）。SELECTORS.deleteMenuItem の調整が必要です。`);
    });

    deleteItem.click();

    const dialog = await waitFor(() => {
      const d = queryAllUnique(SELECTORS.confirmDialog).find(isVisible);
      return d || null;
    }).catch(() => {
      throw new Error(`確認ダイアログが表示されませんでした（カード: ${title}）。SELECTORS.confirmDialog の調整が必要です。`);
    });

    const confirmBtn = await waitFor(() => {
      return findByLabel(
        SELECTORS.confirmDeleteButton.selectors,
        SELECTORS.confirmDeleteButton.labels,
        dialog || document
      );
    }).catch(() => {
      throw new Error(`確認ダイアログ内の削除ボタンが見つかりません（カード: ${title}）。SELECTORS.confirmDeleteButton の調整が必要です。`);
    });

    confirmBtn.click();

    await waitFor(() => {
      return !document.body.contains(card) || !isVisible(dialog);
    }, 8000).catch(() => {
      // ダイアログが閉じたかカードが消えたか厳密に確認できなくても続行する
    });

    await sleep(300);
  }

  async function onExecuteDeleteClick() {
    if (STATE.running) return;
    const targets = Array.from(STATE.selected);
    if (targets.length === 0) return;

    const ok = window.confirm(
      `選択した${targets.length}件のノートブックを削除します。この操作は取り消せません。よろしいですか？`
    );
    if (!ok) return;

    saveQueue(targets);
    await runQueue(targets);
  }

  /**
   * IDキューを順に削除する。処理済みIDは都度 sessionStorage から取り除くため、
   * 途中でページがリロードされても resumeIfNeeded() が残りを自動再開できる。
   */
  async function runQueue(queue) {
    STATE.running = true;
    updatePanel();

    const total = queue.length;
    let successCount = 0;
    let failCount = 0;

    while (queue.length > 0) {
      const id = queue[0];
      const index = total - queue.length + 1;

      let card = findCardById(id);
      if (!card) {
        // 再描画待ちしてから再探索。それでも無ければ削除済みとみなして次へ
        card = await waitFor(() => findCardById(id), 5000).catch(() => null);
      }

      if (card) {
        try {
          await deleteOneCard(card, index, total);
          successCount++;
        } catch (err) {
          failCount++;
          setStatus(`エラー: ${err.message}`, true);
          await sleep(1500);
        }
      }

      STATE.selected.delete(id);
      queue.shift();
      saveQueue(queue);
    }

    STATE.running = false;
    updatePanel();
    setStatus(
      `完了しました。成功: ${successCount}件 / 失敗: ${failCount}件` +
        (failCount > 0 ? "（失敗分はページを再読み込みして再試行してください）" : "")
    );

    decorateCards();
  }

  /** ページ読み込み時に未処理キューが残っていれば削除を自動再開する */
  async function resumeIfNeeded() {
    const queue = loadQueue();
    if (queue.length === 0) return;

    setActive(true);
    setStatus(`ページが再読み込みされたため、残り${queue.length}件の削除を自動再開します...`);

    // カード一覧の描画を待ってから再開
    await waitFor(() => findCards().length > 0, 20000).catch(() => null);
    queue.forEach((id) => STATE.selected.add(id));
    decorateCards();
    await runQueue(loadQueue());
  }

  // ------------------------------------------------------------------
  // 初期化
  // ------------------------------------------------------------------

  function init() {
    if (document.getElementById("nlm-bulk-delete-toggle")) return;
    toggleBtnEl = createToggleButton();
    resumeIfNeeded();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // SPAでの画面遷移・再描画に追従してカード一覧を更新する。
  // 自前UI由来の変異は無視し、デバウンスする（自己発火の無限ループ防止）
  const OWN_UI_SELECTOR =
    "#nlm-bulk-delete-panel, #nlm-bulk-delete-toggle, .nlm-bulk-checkbox-overlay";

  function isOwnMutation(records) {
    return records.every((rec) => {
      const target = rec.target.nodeType === 1 ? rec.target : rec.target.parentElement;
      return target && target.closest && target.closest(OWN_UI_SELECTOR);
    });
  }

  let redecorateTimer = null;
  const rootObserver = new MutationObserver((records) => {
    if (!STATE.active || STATE.running) return;
    if (isOwnMutation(records)) return;
    clearTimeout(redecorateTimer);
    redecorateTimer = setTimeout(() => {
      if (STATE.active && !STATE.running) {
        decorateCards();
        updatePanel();
      }
    }, 300);
  });
  rootObserver.observe(document.documentElement, { childList: true, subtree: true });
})();
