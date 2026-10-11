(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const config = window.EXPERIMENT;

  const screenIds = [
    "startScreen",
    "grayScreen",
    "menuScreen",
    "machineScreen",
    "ratingScreen",
    "finishScreen"
  ];

  let run = null;
  let controller = null;
  let phase = "setup";
  let currentResult = null;
  let preview = false;

  let resolveTicket = null;
  let resolveRating = null;

  // Figmaの1200×1260を縦横比を保って縮小します。
  function fitScreen() {
    const scale = Math.min(
      window.innerWidth * 0.95 / 1200,
      window.innerHeight * 0.95 / 1260
    );

    document.documentElement.style.setProperty("--scale", scale);
  }

  function showScreen(id) {
    screenIds.forEach((screenId) => {
      const screen = $(screenId);
      const visible = screenId === id;

      screen.hidden = !visible;
      screen.inert = !visible;
    });

    document.activeElement?.blur();
    fitScreen();
  }

  function checkAbort() {
    if (controller?.signal.aborted) {
      throw new DOMException("中断しました", "AbortError");
    }
  }

  function nextFrame() {
    return new Promise((resolve, reject) => {
      requestAnimationFrame(() => {
        try {
          checkAbort();
          resolve(performance.now());
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async function afterRender() {
    await nextFrame();
    return nextFrame();
  }

  async function wait(seconds) {
    const endTime = performance.now() + seconds * 1000;

    while (performance.now() < endTime) {
      await nextFrame();
    }

    checkAbort();
  }

  function saveToBrowser() {
    if (!run) return;

    try {
      localStorage.setItem(
        "sense-design-current-run",
        JSON.stringify(run)
      );
    } catch {
      // 保存失敗でも実験は進行し、終了画面から出力できます。
    }
  }

  function enableTickets(enabled) {
    $("ticketButtons")
      .querySelectorAll("button")
      .forEach((button) => {
        button.disabled = !enabled;
      });
  }

  // 上6段は8列、下3段は5列：合計63個。
  function createTickets() {
    $("ticketButtons").replaceChildren();

    for (let row = 0; row < 9; row++) {
      const columns = row < 6 ? 8 : 5;

      for (let column = 0; column < columns; column++) {
        const button = document.createElement("button");

        button.type = "button";
        button.className = "ticket";
        button.style.left = `${column * 135}px`;
        button.style.top = `${row * 107}px`;
        button.setAttribute("aria-label", "食券");
        button.disabled = true;

        if (row === 0 && column === 0) {
          button.classList.add("first");

          const image = document.createElement("img");
          image.src = "assets/ticket-first.svg";
          image.alt = "";
          image.width = 128;
          image.height = 94;

          button.append(image);
        } else {
          [
            "ticket-label",
            "ticket-price",
            "ticket-selection"
          ].forEach((className) => {
            const span = document.createElement("span");
            span.className = className;
            button.append(span);
          });
        }

        button.addEventListener("pointerdown", onTicket);
        button.addEventListener("click", (event) => {
          event.preventDefault();
        });

        $("ticketButtons").append(button);
      }
    }
  }

  function onTicket(event) {
    if (
      preview ||
      phase !== "machine" ||
      !resolveTicket ||
      !event.isPrimary ||
      event.button !== 0 ||
      document.hidden
    ) {
      return;
    }

    // 記録や画面操作より先に入力時刻を取得します。
    const responseTime = performance.now();

    currentResult.response = responseTime;
    currentResult.rt = responseTime - currentResult.onset;

    phase = "post";
    enableTickets(false);
    showScreen("grayScreen");
    saveToBrowser();

    const resolve = resolveTicket;
    resolveTicket = null;
    resolve();
  }

  function onRating(event) {
    if (
      preview ||
      phase !== "rating" ||
      !resolveRating ||
      document.hidden
    ) {
      return;
    }

    const rating = Number(event.target.value);

    if (!Number.isInteger(rating) || rating < 1 || rating > 7) {
      return;
    }

    currentResult.rating = rating;

    phase = "between";
    showScreen("grayScreen");
    saveToBrowser();

    const resolve = resolveRating;
    resolveRating = null;
    resolve();
  }

  async function showGray(seconds, plain = false) {
    phase = "gray";

    $("grayScreen").classList.toggle("plain-base", plain);
    showScreen("grayScreen");

    await afterRender();
    await wait(seconds);
  }

  async function runTask(taskId, index, settings) {
    currentResult = {
      task: taskId,
      position: index + 1,
      onset: null,
      response: null,
      rt: null,
      rating: null
    };

    run.results.push(currentResult);
    saveToBrowser();

    // 1. 対象メニューの案内：背景のみ8秒
    await showGray(settings.times.intro, true);

    // 2. メニュー15秒
    $("menuName").textContent = settings.tasks[taskId].name;
    showScreen("menuScreen");

    await afterRender();
    await wait(settings.times.menu);

    // 3. 灰色15秒
    // 実験者は10秒経過時に開始指示を読み上げます。
    await showGray(settings.times.baseline);

    // 4. 券売機：表示後に反応時間の計測を開始
    enableTickets(false);
    showScreen("machineScreen");

    currentResult.onset = await afterRender();

    const ticketAnswer = new Promise((resolve) => {
      resolveTicket = resolve;
    });

    phase = "machine";
    enableTickets(true);

    await ticketAnswer;
    checkAbort();

    // 5. 回答後の灰色15秒：実験者が評価の案内
    await showGray(settings.times.post);

    // 6. 評価：1つ回答するまで待機
    $("ratingForm").reset();
    showScreen("ratingScreen");

    await afterRender();

    const ratingAnswer = new Promise((resolve) => {
      resolveRating = resolve;
    });

    phase = "rating";

    await ratingAnswer;
    checkAbort();

    // 7. 次のTask前、または終了前の灰色10秒
    await showGray(settings.times.between);
  }

  async function startExperiment(event) {
    event.preventDefault();

    if (run?.status === "running") return;
    if (!$("startForm").reportValidity()) return;

    if (!config) {
      $("startError").textContent =
        "js/config.jsが読み込まれていません。";
      return;
    }

    const set = Number($("experimentSet").value);
    const order = config.sets[set];

    if (!order) {
      $("startError").textContent =
        "実験セットを選択してください。";
      return;
    }

    preview = false;
    controller = new AbortController();
    $("startButton").disabled = true;
    $("startError").textContent = "";

    // 開始時の設定と順序を固定します。
    const settings = structuredClone(config);

    run = {
      student: $("studentId").value.trim(),
      set,
      order: [...order],
      startedAt: new Date().toISOString(),
      status: "running",
      prototype: true,
      reason: "",
      settings,
      results: []
    };

    try {
      // 全画面表示が拒否されても通常画面で続行します。
      if (
        $("useFullscreen").checked &&
        !document.fullscreenElement
      ) {
        try {
          await document.documentElement.requestFullscreen();
        } catch {
          // 通常画面で続行
        }
      }

      const images = [
        ...$("ticketButtons").querySelectorAll("img")
      ];

      try {
        await Promise.all(images.map((image) => image.decode()));
      } catch {
        throw new Error(
          "assets/ticket-first.svgがありません。" +
          "ZIP内のassetsフォルダーを配置してください。"
        );
      }

      checkAbort();

      for (let index = 0; index < run.order.length; index++) {
        await runTask(run.order[index], index, settings);
      }

      run.status = "complete";
      run.endedAt = new Date().toISOString();

      showResults("ご協力ありがとうございました。");
    } catch (error) {
      if (run.status === "running") {
        run.status = "aborted";
        run.reason = error.message;
        run.endedAt = new Date().toISOString();
        showResults(error.message);
      }
    } finally {
      $("startButton").disabled = false;
    }
  }

  function showResults(message) {
    resolveTicket = null;
    resolveRating = null;
    phase = "finished";

    $("finishTitle").textContent =
      run.status === "complete"
        ? "実験が終了しました"
        : "実験を中断しました";

    $("finishMessage").textContent = message;

    $("resultSummary").textContent =
      `学籍番号：${run.student} ／ セット${run.set} ／ ` +
      run.order.join(" → ");

    $("resultRows").replaceChildren();

    run.results.forEach((result) => {
      const row = document.createElement("tr");

      const values = [
        result.position,
        result.task,
        result.rt === null ? "未回答" : result.rt.toFixed(2),
        result.rating ?? "未回答"
      ];

      values.forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      });

      $("resultRows").append(row);
    });

    showScreen("finishScreen");
    saveToBrowser();
  }

  function abortExperiment(reason) {
    if (!run || run.status !== "running") return;

    controller.abort();

    run.status = "aborted";
    run.reason = reason;
    run.endedAt = new Date().toISOString();

    // 入力待ちを解除し、処理を終了させます。
    resolveTicket?.();
    resolveRating?.();

    showResults(reason);
  }

  function download(text, filename, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = filename;
    link.click();

    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function csvCell(value) {
    let text = String(value ?? "");

    if (/^[\s]*[=+@-]/.test(text)) {
      text = "'" + text;
    }

    return `"${text.replaceAll('"', '""')}"`;
  }

  function downloadCsv() {
    if (!run) return;

    const rows = [
      [
        "学籍番号",
        "セット",
        "順序",
        "状態",
        "提示順",
        "Task",
        "反応時間(ms)",
        "評価"
      ],
      ...run.results.map((result) => [
        run.student,
        run.set,
        run.order.join("→"),
        run.status,
        result.position,
        result.task,
        result.rt,
        result.rating
      ])
    ];

    const csv = "\uFEFF" +
      rows.map((row) => row.map(csvCell).join(",")).join("\r\n");

    download(
      csv,
      "sense-design-results.csv",
      "text/csv;charset=utf-8"
    );
  }

  function exitPreview() {
    preview = false;
    phase = "setup";
    $("previewExit").hidden = true;
    showScreen("startScreen");
  }

  // 操作イベント
  $("startForm").addEventListener("submit", startExperiment);

  $("ratingForm").addEventListener("change", onRating);
  $("ratingForm").addEventListener("submit", (event) => {
    event.preventDefault();
  });

  $("experimentSet").addEventListener("change", () => {
    $("orderPreview").textContent =
      config.sets[$("experimentSet").value].join(" → ");
  });

  $("downloadCsv").addEventListener("click", downloadCsv);

  $("downloadJson").addEventListener("click", () => {
    if (!run) return;

    download(
      JSON.stringify(run, null, 2),
      "sense-design-results.json",
      "application/json"
    );
  });

  $("returnToStart").addEventListener("click", () => {
    run = null;
    controller = null;
    phase = "setup";
    showScreen("startScreen");
  });

  document.querySelectorAll("[data-preview]").forEach((button) => {
    button.addEventListener("click", () => {
      preview = true;
      controller = null;
      phase = "preview";

      $("ratingForm").reset();
      enableTickets(false);
      showScreen(button.dataset.preview);
      $("previewExit").hidden = false;
    });
  });

  $("previewExit").addEventListener("click", exitPreview);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;

    if (preview) {
      exitPreview();
    } else {
      abortExperiment("Escキーで中断しました。");
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      abortExperiment("実験中にページが非表示になりました。");
    }
  });

  window.addEventListener("resize", () => {
    fitScreen();

    if (phase !== "setup" && run?.status === "running") {
      abortExperiment("実験中に画面サイズが変わりました。");
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (run?.status === "running") {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  // 初期表示
  createTickets();
  fitScreen();
  showScreen("startScreen");
})();
