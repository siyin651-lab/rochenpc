// ============================================================
// NPC 生成器 v1.3.0
// 根据角色人设 + 用户指定的侧重点，精准生成 NPC
// ============================================================

window.RochePlugin.register({
  id: "npc-generator",
  name: "NPC 生成器",
  version: "1.3.0",
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
          generatedNpcs: [],
          loading: false,
          message: "",
          messageType: "info",
          generationFocus: "comprehensive", // 新增：侧重点
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

        // ---------- 数据库操作（与之前相同，已验证可用） ----------
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

          let fullPersona = npc.persona || "";
          if (npc.relation) {
            fullPersona = `【与主角的关系】${npc.relation}\n${fullPersona}`;
          }
          if (npc.source) {
            fullPersona += `\n【生成依据】${npc.source}`;
          }

          const contact = {
            id: charId,
            name: npc.name || "未命名",
            handle: npc.handle || npc.name || "NPC",
            bio: npc.bio || "",
            persona: fullPersona,
            avatar: "",
            conversationId: convId,
            createdAt: now,
            updatedAt: now,
          };

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
            let completed = 0;
            let hasError = false;
            const req1 = contactStore.add(contact);
            req1.onsuccess = () => {
              completed++;
              if (completed === 2 && !hasError) resolve();
            };
            req1.onerror = (e) => { hasError = true; reject(e); };

            const req2 = convStore.add(conversation);
            req2.onsuccess = () => {
              completed++;
              if (completed === 2 && !hasError) resolve();
            };
            req2.onerror = (e) => { hasError = true; reject(e); };
          });

          db.close();

          // 验证写入
          const verifyDb = await openDB();
          const verifyTx = verifyDb.transaction("contacts", "readonly");
          const verifyStore = verifyTx.objectStore("contacts");
          const verifyReq = verifyStore.get(charId);
          const verifyResult = await new Promise((resolve) => {
            verifyReq.onsuccess = () => resolve(verifyReq.result);
            verifyReq.onerror = () => resolve(null);
          });
          verifyDb.close();

          if (!verifyResult) {
            throw new Error("写入后回读失败，数据未持久化");
          }

          return { charId, convId };
        }

        // ---------- 加载角色 ----------
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

        // ---------- 核心：AI 生成 NPC（增强版） ----------
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

          // ---------- 根据侧重点构建不同的指令 ----------
          const focusMap = {
            "family": "重点提取人设中提到的家人、亲属或有血缘关系的人物。",
            "rival": "重点提取人设中提到的敌人、竞争对手、宿敌。",
            "mentor": "重点提取人设中提到的老师、前辈、引路人、同门。",
            "friend": "重点提取人设中提到的朋友、挚友、伙伴。",
            "comprehensive": "综合提取所有可能的人物关系，包括家人、朋友、敌人、同事等。"
          };
          const focusInstruction = focusMap[state.generationFocus] || focusMap["comprehensive"];

          // ---------- 强约束提示词 ----------
          const systemPrompt = `你是一位严谨的世界构建师。你的任务是从主角的人设中提取出所有可能的相关人物，并生成 NPC。

【主角信息】
姓名：${charName}
完整人设：
${persona}

【生成目标】
${focusInstruction}

【严格指令】
1. 仔细阅读以上人设，找出所有与 ${charName} 有关的人物线索（即使只提过一次名字或暗示关系）。
2. 每个 NPC 必须基于人设中的**具体语句或设定**衍生出来。你需要指出每个 NPC 的**生成依据**，即人设中的哪句话/哪段描述引出了这个 NPC（尽量引用原文）。
3. 生成 3~5 个 NPC。
4. 每个 NPC 必须包含以下字段：
   - name：正式姓名（中文）
   - handle：昵称或代号（2~4 字）
   - bio：一句简短的身份介绍（20 字以内）
   - relation：与 ${charName} 的具体关系（必须具体，如“表妹，家族联姻的牺牲品”）
   - source：引用人设原文中**至少一句话**作为生成依据（例如：“人设中提到 '主角的堂妹在十年前离家出走'”）
   - persona：详细人设，包括性格、背景、与主角的过往交集（50~100 字）

【输出格式】
必须输出严格的 JSON 数组，不要有其他文字。示例（不同侧重点示例）：
- 侧重亲友：
[
  {
    "name": "林小蝶",
    "handle": "小蝶",
    "bio": "主角的胞妹，天真烂漫",
    "relation": "亲妹妹，主角最疼爱的家人",
    "source": "人设中提到 '主角有一个妹妹叫林小蝶，自幼体弱多病'",
    "persona": "..."
  }
]
- 侧重敌对：
[
  {
    "name": "赵无影",
    "handle": "无影",
    "bio": "神秘刺客，主角的宿敌",
    "relation": "宿敌，多次刺杀主角未果",
    "source": "人设中提到 '赵无影是主角最大的敌人，两人交手七次'",
    "persona": "..."
  }
]`;

          state.loading = true;
          showMessage(`AI 正在从人设中提取“${focusMap[state.generationFocus] || '综合'}”相关 NPC，请稍候...`, "info");
          render();

          try {
            const result = await roche.ai.chat({
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: "请根据以上人设和侧重点，生成 NPC 列表。" }
              ],
              temperature: 0.6, // 更低，更忠实
            });

            let rawText = result.text || "";
            rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();

            let npcs = [];
            try {
              npcs = JSON.parse(rawText);
            } catch (parseErr) {
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

            npcs = npcs.map(n => ({
              ...n,
              relation: n.relation || "与主角有联系",
              source: n.source || "（未提供来源）",
              persona: n.persona || n.bio || "",
            }));

            state.generatedNpcs = npcs;
            state.loading = false;
            showMessage(`✅ 成功生成 ${npcs.length} 个 NPC！每个 NPC 都附带了「生成依据」，可追溯来源。`, "success");
          } catch (e) {
            state.loading = false;
            showMessage("生成失败：" + e.message, "error");
          }
          render();
        }

        // ---------- 添加 ----------
        async function handleAddNpc(npc, index) {
          try {
            await addNpcToDB(npc);
            state.generatedNpcs[index]._added = true;
            showMessage(`✅ ${npc.name}（${npc.handle}）已成功写入数据库！\n请刷新 Roche 页面，即可在联系人列表看到。`, "success");
            render();
          } catch (e) {
            showMessage(`❌ 添加 ${npc.name} 失败：` + e.message, "error");
            console.error("Add NPC error:", e);
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

          const title = document.createElement("h1");
          title.textContent = "🧙 NPC 生成器 v1.3";
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
            state.generatedNpcs = [];
            state.message = "";
            render();
          };
          charSection.appendChild(charSelect);
          root.appendChild(charSection);

          // ---------- 新增：侧重点选择 ----------
          const focusSection = document.createElement("div");
          focusSection.style.marginBottom = "16px";
          const focusLabel = document.createElement("label");
          focusLabel.textContent = "② 生成侧重点";
          focusLabel.style.display = "block";
          focusLabel.style.marginBottom = "6px";
          focusLabel.style.fontWeight = "500";
          focusSection.appendChild(focusLabel);

          const focusGroup = document.createElement("div");
          focusGroup.style.display = "flex";
          focusGroup.style.gap = "8px";
          focusGroup.style.flexWrap = "wrap";

          const focusOptions = [
            { id: "comprehensive", label: "综合" },
            { id: "family", label: "家人" },
            { id: "friend", label: "朋友" },
            { id: "rival", label: "敌对" },
            { id: "mentor", label: "导师/同门" },
          ];
          focusOptions.forEach(f => {
            const btn = document.createElement("button");
            btn.textContent = f.label;
            btn.className = "btn";
            if (state.generationFocus === f.id) btn.classList.add("active");
            btn.style.cssText = `
              padding: 4px 12px;
              border: 1px solid ${state.generationFocus === f.id ? "#6c5ce7" : "#444"};
              border-radius: 16px;
              background: ${state.generationFocus === f.id ? "#6c5ce7" : "#2a2a3e"};
              color: ${state.generationFocus === f.id ? "#fff" : "#ccc"};
              cursor: pointer;
              font-size: 13px;
              transition: 0.2s;
            `;
            btn.onclick = () => {
              state.generationFocus = f.id;
              render();
            };
            focusGroup.appendChild(btn);
          });
          focusSection.appendChild(focusGroup);

          const focusHint = document.createElement("div");
          focusHint.style.cssText = "font-size: 12px; color: #888; margin-top: 4px;";
          focusHint.textContent = "💡 选择侧重点后，AI 会从人设中提取对应关系的 NPC，其他无关的不会生成。";
          focusSection.appendChild(focusHint);
          root.appendChild(focusSection);

          // 生成按钮
          const genSection = document.createElement("div");
          genSection.style.marginBottom = "16px";
          const genBtn = document.createElement("button");
          genBtn.textContent = state.loading ? "⏳ 生成中..." : "③ 生成 NPC";
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

          // 消息
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
            listTitle.textContent = `④ 生成的 NPC（${state.generatedNpcs.length} 个）`;
            listTitle.style.cssText = "font-weight: 500; margin-bottom: 10px; font-size: 15px;";
            root.appendChild(listTitle);

            const grid = document.createElement("div");
            grid.style.display = "grid";
            grid.style.gridTemplateColumns = "repeat(auto-fill, minmax(300px, 1fr))";
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

              if (npc.relation) {
                const relationEl = document.createElement("div");
                relationEl.style.cssText = `
                  font-size: 13px; color: #ffd479; margin: 4px 0 6px 0;
                  background: rgba(255, 212, 121, 0.1); padding: 2px 8px; border-radius: 4px;
                  display: inline-block;
                `;
                relationEl.textContent = "🔗 " + npc.relation;
                card.appendChild(relationEl);
              }

              const bioEl = document.createElement("div");
              bioEl.style.cssText = "font-size: 13px; color: #aaa; margin: 6px 0 8px 0;";
              bioEl.textContent = npc.bio || "";
              card.appendChild(bioEl);

              if (npc.source) {
                const sourceEl = document.createElement("div");
                sourceEl.style.cssText = `
                  font-size: 12px; color: #7ee787; background: rgba(126, 231, 135, 0.08);
                  padding: 4px 8px; border-radius: 4px; margin-bottom: 6px;
                  border-left: 2px solid #4caf50;
                `;
                sourceEl.textContent = "📝 依据：" + npc.source;
                card.appendChild(sourceEl);
              }

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

          // 关闭
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
              .btn.active {
                border-color: #6c5ce7 !important;
                background: #6c5ce7 !important;
                color: #fff !important;
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
