// ============================================================
// NPC 生成器 v1.0
// 根据角色人设，AI 生成相关 NPC 并添加为好友
// ============================================================

window.RochePlugin.register({
  id: "npc-generator",
  name: "NPC 生成器",
  version: "1.0.0",
  apps: [
    {
      id: "npc-generator-home",
      name: "NPC 生成器",
      icon: "group",
      iconImage: "",
      async mount(container, roche) {
        // ---------- 状态 ----------
        const state = {
          characters: [],
          selectedCharId: "",
          generatedNpcs: [],      // { name, handle, bio, persona }
          loading: false,
          message: "",
          messageType: "info",
        };

        // ---------- 工具函数 ----------
        function showMessage(text, type = "info") {
          state.message = text;
          state.messageType = type;
          render();
        }

        function genId(prefix) {
          return prefix + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
        }

        // ---------- 数据库操作（直接写入 IndexedDB） ----------
        function openDB() {
          const DB_NAME = "Roche_db";
          const DB_VERSION = 78;
          return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(new Error("打开数据库失败：" + req.error));
            req.onupgradeneeded = () => {};
          });
        }

        async function addNpcToDB(npc) {
          const db = await openDB();
          const charId = genId("char");
          const convId = genId("conv");
          const now = Date.now();

          // 1. 写入 contacts
          const contact = {
            id: charId,
            name: npc.name || "未命名",
            handle: npc.handle || npc.name || "NPC",
            bio: npc.bio || "",
            persona: npc.persona || npc.bio || "",
            avatar: "",
            conversationId: convId,
            createdAt: now,
            updatedAt: now,
          };

          // 2. 写入 conversations（单聊）
          const conversation = {
            id: convId,
            contactId: charId,
            type: "dm",
            isGroup: false,
            name: npc.name || "未命名",
            handle: npc.handle || npc.name || "NPC",
            avatar: "",
            members: [charId],
            memberProfiles: [],
            createdAt: now,
            updatedAt: now,
          };

          const tx = db.transaction(["contacts", "conversations"], "readwrite");
          const contactStore = tx.objectStore("contacts");
          const convStore = tx.objectStore("conversations");

          await new Promise((resolve, reject) => {
            const req1 = contactStore.add(contact);
            req1.onsuccess = () => {};
            req1.onerror = () => reject(req1.error);

            const req2 = convStore.add(conversation);
            req2.onsuccess = () => {};
            req2.onerror = () => reject(req2.error);

            // 等待两个都完成
            let completed = 0;
            let hasError = false;
            req1.onsuccess = () => {
              completed++;
              if (completed === 2 && !hasError) resolve();
            };
            req2.onsuccess = () => {
              completed++;
              if (completed === 2 && !hasError) resolve();
            };
            req1.onerror = (e) => { hasError = true; reject(e); };
            req2.onerror = (e) => { hasError = true; reject(e); };
          });

          db.close();
          return { charId, convId };
        }

        // ---------- 加载角色列表 ----------
        async function loadCharacters() {
          try {
            const chars = await roche.character.list();
            state.characters = chars || [];
            if (!state.selectedCharId && state.characters.length > 0) {
              state.selectedCharId = state.characters[0].id;
            }
          } catch (e) {
            showMessage("加载角色失败：" + e.message, "error");
          }
        }

        // ---------- 核心：AI 生成 NPC ----------
        async function generateNpcs() {
          if (!state.selectedCharId) {
            showMessage("请先选择一个角色", "error");
            return;
          }

          let character;
          try {
            character = await roche.character.get(state.selectedCharId);
          } catch (e) {
            showMessage("获取角色信息失败：" + e.message, "error");
            return;
          }
          if (!character) {
            showMessage("角色不存在", "error");
            return;
          }

          const persona = character.persona || character.bio || "";
          if (!persona) {
            showMessage("该角色没有设置人设（persona），请先完善人设", "error");
            return;
          }

          const charName = character.name || "主角";

          const systemPrompt = `你是一位优秀的世界构建师。请根据以下角色人设，生成 3~5 个与该角色有紧密联系的 NPC（非玩家角色）。

角色姓名：${charName}
角色人设：
${persona}

生成要求：
1. 每个 NPC 需包含以下字段：
   - name：正式姓名（中文名）
   - handle：昵称或代号（简短，2~4 字）
   - bio：一句简短的身份介绍（20 字以内）
   - persona：详细人设，包括性格特点、背景故事、与 ${charName} 的关系（50~100 字）
2. NPC 要贴合主角的世界观，关系可以是朋友、敌人、亲人、导师、对手等。

请以**严格的 JSON 数组格式**输出，不要有其他任何文字。示例格式：
[
  {
    "name": "林暮雪",
    "handle": "暮雪",
    "bio": "清冷孤高的剑客，曾是主角的同门师妹",
    "persona": "性格清冷寡言，剑术超群。幼时被主角从雪地中救起，因此对主角既感恩又抱有隐秘的竞争之心。..."
  }
]`;

          state.loading = true;
          showMessage("AI 正在生成 NPC，请稍候...", "info");
          render();

          try {
            const result = await roche.ai.chat({
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: "请生成。" }
              ],
              temperature: 0.85,
            });

            let rawText = result.text || "";
            // 清理 Markdown 代码块
            rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();

            let npcs = [];
            try {
              npcs = JSON.parse(rawText);
            } catch (parseErr) {
              // 尝试提取数组部分
              const match = rawText.match(/\[[\s\S]*\]/);
              if (match) {
                try {
                  npcs = JSON.parse(match[0]);
                } catch (e2) {
                  throw new Error("AI 返回格式无法解析，请重试。原始内容：\n" + rawText.slice(0, 200));
                }
              } else {
                throw new Error("AI 返回格式无法解析，请重试。原始内容：\n" + rawText.slice(0, 200));
              }
            }

            if (!Array.isArray(npcs) || npcs.length === 0) {
              throw new Error("AI 未返回有效的 NPC 列表");
            }

            state.generatedNpcs = npcs;
            state.loading = false;
            showMessage(`✅ 成功生成 ${npcs.length} 个 NPC！点击「添加好友」即可入库。`, "success");
          } catch (e) {
            state.loading = false;
            showMessage("生成失败：" + e.message, "error");
          }
          render();
        }

        // ---------- 添加单个 NPC 为好友 ----------
        async function handleAddNpc(npc, index) {
          try {
            await addNpcToDB(npc);
            // 标记已添加（UI 反馈）
            state.generatedNpcs[index]._added = true;
            showMessage(`✅ ${npc.name}（${npc.handle}）已添加为好友！刷新页面即可在角色列表看到。`, "success");
            render();
          } catch (e) {
            showMessage(`❌ 添加 ${npc.name} 失败：` + e.message, "error");
          }
        }

        // ---------- UI 渲染 ----------
        function render() {
          container.innerHTML = "";

          const root = document.createElement("div");
          root.style.cssText = `
            display: flex;
            flex-direction: column;
            height: 100%;
            padding: 20px;
            background: #1a1a2e;
            color: #eee;
            font-family: system-ui, sans-serif;
            overflow-y: auto;
            box-sizing: border-box;
          `;

          // 标题
          const title = document.createElement("h1");
          title.textContent = "🧙 NPC 生成器";
          title.style.cssText = "font-size: 24px; margin: 0 0 16px 0; font-weight: 300;";
          root.appendChild(title);

          // 选择角色
          const charSection = document.createElement("div");
          charSection.style.marginBottom = "16px";
          const charLabel = document.createElement("label");
          charLabel.textContent = "① 选择主角";
          charLabel.style.display = "block";
          charLabel.style.marginBottom = "6px";
          charLabel.style.fontWeight = "500";
          charSection.appendChild(charLabel);

          const charSelect = document.createElement("select");
          charSelect.style.cssText = `
            width: 100%; padding: 8px; background: #2a2a3e; color: #eee;
            border: 1px solid #444; border-radius: 8px; font-size: 14px;
          `;
          if (state.characters.length === 0) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "没有角色，请先创建";
            charSelect.appendChild(opt);
          } else {
            state.characters.forEach(c => {
              const opt = document.createElement("option");
              opt.value = c.id;
              opt.textContent = c.handle || c.name || c.id;
              if (c.id === state.selectedCharId) opt.selected = true;
              charSelect.appendChild(opt);
            });
          }
          charSelect.onchange = () => {
            state.selectedCharId = charSelect.value;
            // 切换角色时清空之前的 NPC
            state.generatedNpcs = [];
            state.message = "";
            render();
          };
          charSection.appendChild(charSelect);

          // 提示：检查人设
          const hint = document.createElement("div");
          hint.style.cssText = "font-size: 12px; color: #888; margin-top: 4px;";
          hint.textContent = "💡 生成 NPC 依赖角色的「人设（persona）」，请确保已填写完整。";
          charSection.appendChild(hint);
          root.appendChild(charSection);

          // 生成按钮
          const genSection = document.createElement("div");
          genSection.style.marginBottom = "16px";
          const genBtn = document.createElement("button");
          genBtn.textContent = state.loading ? "⏳ 生成中..." : "② 生成 NPC";
          genBtn.className = "btn primary";
          genBtn.style.cssText = `
            width: 100%; padding: 12px; font-size: 16px;
            background: #6c5ce7; border: none; border-radius: 8px;
            color: #fff; cursor: pointer; transition: 0.2s;
          `;
          genBtn.disabled = state.loading || state.characters.length === 0;
          genBtn.onclick = generateNpcs;
          genSection.appendChild(genBtn);
          root.appendChild(genSection);

          // 消息显示
          if (state.message) {
            const msgBox = document.createElement("div");
            const color = state.messageType === "success" ? "#4caf50" : state.messageType === "error" ? "#f44336" : "#ff9800";
            msgBox.style.cssText = `
              margin-bottom: 16px; padding: 10px; background: #16161c;
              border-radius: 6px; border-left: 3px solid ${color};
              color: #ccc; font-size: 13px; white-space: pre-wrap;
            `;
            msgBox.textContent = state.message;
            root.appendChild(msgBox);
          }

          // NPC 列表
          if (state.generatedNpcs.length > 0) {
            const listTitle = document.createElement("div");
            listTitle.textContent = `③ 生成的 NPC（${state.generatedNpcs.length} 个）`;
            listTitle.style.cssText = "font-weight: 500; margin-bottom: 10px; font-size: 15px;";
            root.appendChild(listTitle);

            const grid = document.createElement("div");
            grid.style.display = "grid";
            grid.style.gridTemplateColumns = "repeat(auto-fill, minmax(280px, 1fr))";
            grid.style.gap = "12px";

            state.generatedNpcs.forEach((npc, index) => {
              const card = document.createElement("div");
              card.style.cssText = `
                background: #22223a; border-radius: 10px; padding: 14px;
                border: 1px solid #333; transition: 0.2s;
              `;

              const nameRow = document.createElement("div");
              nameRow.style.cssText = "display: flex; justify-content: space-between; align-items: center;";
              const nameEl = document.createElement("div");
              nameEl.style.cssText = "font-weight: 600; font-size: 16px;";
              nameEl.textContent = npc.name || "未命名";
              const handleEl = document.createElement("span");
              handleEl.style.cssText = "font-size: 13px; color: #aaa; margin-left: 8px;";
              handleEl.textContent = `（${npc.handle || ""}）`;
              nameEl.appendChild(handleEl);
              nameRow.appendChild(nameEl);
              card.appendChild(nameRow);

              const bioEl = document.createElement("div");
              bioEl.style.cssText = "font-size: 13px; color: #aaa; margin: 6px 0 8px 0;";
              bioEl.textContent = npc.bio || "";
              card.appendChild(bioEl);

              const personaEl = document.createElement("div");
              personaEl.style.cssText = "font-size: 12px; color: #9aa0a6; line-height: 1.5; max-height: 60px; overflow: hidden; text-overflow: ellipsis;";
              personaEl.textContent = npc.persona || "";
              card.appendChild(personaEl);

              const actionRow = document.createElement("div");
              actionRow.style.cssText = "margin-top: 12px; display: flex; gap: 8px;";

              const addBtn = document.createElement("button");
              if (npc._added) {
                addBtn.textContent = "✅ 已添加";
                addBtn.disabled = true;
                addBtn.style.cssText = "padding: 6px 14px; background: #2a2a3e; border: 1px solid #4caf50; border-radius: 6px; color: #4caf50; font-size: 13px; cursor: default;";
              } else {
                addBtn.textContent = "➕ 添加好友";
                addBtn.style.cssText = "padding: 6px 14px; background: #4caf50; border: none; border-radius: 6px; color: #fff; font-size: 13px; cursor: pointer; transition: 0.2s;";
                addBtn.onmouseover = () => addBtn.style.background = "#388e3c";
                addBtn.onmouseout = () => addBtn.style.background = "#4caf50";
                addBtn.onclick = () => handleAddNpc(npc, index);
              }
              actionRow.appendChild(addBtn);
              card.appendChild(actionRow);

              grid.appendChild(card);
            });

            root.appendChild(grid);
          }

          // 关闭按钮
          const closeBtn = document.createElement("button");
          closeBtn.textContent = "✕ 关闭";
          closeBtn.style.cssText = `
            margin-top: 20px; padding: 8px 16px; background: transparent;
            border: 1px solid #555; border-radius: 6px; color: #aaa;
            cursor: pointer; align-self: flex-start; transition: 0.2s;
          `;
          closeBtn.onmouseover = () => closeBtn.style.borderColor = "#888";
          closeBtn.onmouseout = () => closeBtn.style.borderColor = "#555";
          closeBtn.onclick = () => roche.ui.closeApp();
          root.appendChild(closeBtn);

          container.appendChild(root);

          // 注入全局样式（一次）
          if (!document.getElementById("npc-generator-style")) {
            const style = document.createElement("style");
            style.id = "npc-generator-style";
            style.textContent = `
              .btn.primary:hover {
                background: #5a4bd1 !important;
              }
              .btn.primary:disabled {
                opacity: 0.5;
                cursor: not-allowed;
              }
            `;
            document.head.appendChild(style);
          }
        }

        // ---------- 初始化 ----------
        await loadCharacters();
        render();
      },
      async unmount(container) {
        container.replaceChildren();
        const style = document.getElementById("npc-generator-style");
        if (style) style.remove();
      }
    }
  ]
});