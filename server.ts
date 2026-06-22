import express from "express";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
// @ts-ignore
import pdf from "pdf-parse";
// @ts-ignore
import mammoth from "mammoth";
// @ts-ignore
import * as XLSX from "xlsx";

const execAsync = promisify(exec);

// Load environment variables
dotenv.config();

// Lazy Gemini client helper
let geminiClient: GoogleGenAI | null = null;
function getGeminiClient(customKey?: string): GoogleGenAI {
  if (customKey) {
    return new GoogleGenAI({
      apiKey: customKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  if (!geminiClient) {
    const key = process.env.GEMINI_API_KEY || "";
    geminiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return geminiClient;
}

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ limit: "15mb", extended: true }));

// Ensure directories exist
const CONVERSATIONS_DIR = path.join(process.cwd(), "data", "conversations");
const LESSONS_FILE = path.join(process.cwd(), "data", "lessons.json");
const CUSTOM_TOOLS_DIR = path.join(process.cwd(), "data", "custom_tools");
const CUSTOM_TOOLS_MANIFEST = path.join(CUSTOM_TOOLS_DIR, "manifest.json");

/**
 * Translates Docker container mount paths to align with host directories.
 * Isomorphic: correctly handles both Docker runtimes and bare metal VPS hosting.
 */
function translatePath(filePath: string): string {
  if (!filePath) return filePath;
  let p = filePath.replace(/\\/g, "/");

  const inDocker = existsSync("/.dockerenv");

  if (inDocker) {
    // Map host /root/agent/data/ or ./root/agent/data/ to container /data/
    p = p.replace(/^\/?root\/agent\/data\//i, "/data/");
    p = p.replace(/^\.\/root\/agent\/data\//i, "/data/");

    // Map host /root/workinfo/ or ./root/workinfo/ to container /workinfo/
    p = p.replace(/^\/?root\/workinfo\//i, "/workinfo/");
    p = p.replace(/^\.\/root\/workinfo\//i, "/workinfo/");

    const isSystemData = p.includes("data/custom_tools/") || 
                          p.includes("data/lessons.json") || 
                          p.includes("data/conversations/");

    if (!isSystemData) {
      if (p.startsWith("data/")) {
        p = "/data/" + p.slice(5);
      } else if (p.startsWith("./data/")) {
        p = "/data/" + p.slice(7);
      }
      
      if (p.startsWith("workinfo/")) {
        p = "/workinfo/" + p.slice(9);
      } else if (p.startsWith("./workinfo/")) {
        p = "/workinfo/" + p.slice(11);
      }
    }

    // Map any outside absolute paths to the /host mount
    if (p.startsWith("/")) {
      const isInternal = p.startsWith("/app") || p.startsWith("/data") || p.startsWith("/workinfo") || p.startsWith("/host") || p.startsWith("/tmp");
      if (!isInternal) {
        p = "/host" + p;
      }
    }
  } else {
    // Bare metal VPS - map container path references back to actual local paths if they occur
    if (p.startsWith("/data/")) {
      p = "data/" + p.slice(6);
    } else if (p === "/data" || p === "data") {
      p = "data";
    }
    
    if (p.startsWith("/workinfo/")) {
      if (existsSync("/root/workinfo")) {
        p = "/root/workinfo/" + p.slice(10);
      } else {
        p = "workinfo/" + p.slice(10);
      }
    } else if (p === "/workinfo" || p === "workinfo") {
      if (existsSync("/root/workinfo")) {
        p = "/root/workinfo";
      } else {
        p = "workinfo";
      }
    }
  }

  const resolved = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  return resolved;
}

const initDirectories = async () => {
  try {
    await fs.mkdir(CONVERSATIONS_DIR, { recursive: true });
    await fs.mkdir(CUSTOM_TOOLS_DIR, { recursive: true });
    console.log(`Directories normalized: ${CONVERSATIONS_DIR} and ${CUSTOM_TOOLS_DIR}`);

    const inDocker = existsSync("/.dockerenv");

    if (inDocker) {
      // Create symbolic links inside /app/data to redirect /data mounts
      const ensureSymlink = async (targetPath: string, linkPath: string) => {
        try {
          await fs.mkdir(targetPath, { recursive: true });
          
          let exists = false;
          let isSymlink = false;
          try {
            const stats = await fs.lstat(linkPath);
            exists = true;
            isSymlink = stats.isSymbolicLink();
          } catch {}

          if (exists) {
            if (isSymlink) {
              console.log(`[Symlink Engine] Already configured: ${linkPath} -> ${targetPath}`);
              return;
            }
            console.warn(`[Symlink Engine] Real directory exists at link target, backing up and replacing: ${linkPath}`);
            await fs.rm(linkPath, { recursive: true, force: true });
          }

          await fs.symlink(targetPath, linkPath, "dir");
          console.log(`[Symlink Engine] Created symlink: ${linkPath} -> ${targetPath}`);
        } catch (smErr: any) {
          console.warn(`[Symlink Engine] Failed linking ${linkPath} -> ${targetPath}:`, smErr.message);
        }
      };

      // Ensure link redirection
      await ensureSymlink("/data/user_uploads", path.join(process.cwd(), "data", "user_uploads"));
      await ensureSymlink("/data/input", path.join(process.cwd(), "data", "input"));
      await ensureSymlink("/data/output", path.join(process.cwd(), "data", "output"));
      await ensureSymlink("/workinfo", path.join(process.cwd(), "workinfo"));
    } else {
      // Bare metal - just make local directories inside project
      await fs.mkdir(path.join(process.cwd(), "data", "user_uploads"), { recursive: true });
      await fs.mkdir(path.join(process.cwd(), "data", "input"), { recursive: true });
      await fs.mkdir(path.join(process.cwd(), "data", "output"), { recursive: true });
      
      if (existsSync("/root/workinfo")) {
        console.log("[Bare Metal Engine] Global /root/workinfo exists on host and will be utilized.");
      } else {
        await fs.mkdir(path.join(process.cwd(), "workinfo"), { recursive: true });
        console.log("[Bare Metal Engine] Created local ./workinfo directory.");
      }
    }

    // Seed default lessons if missing
    try {
      await fs.access(LESSONS_FILE);
    } catch {
      const defaultLessons = [
        {
          id: "seed-env",
          category: "VPS Конфигурация",
          title: "Иерархия окружения VPS",
          details: "Суперагент работает внутри контейнера Linux Alpine Docker. Доступны команды git, npx, bash, npm. Идеально подходит для проектирования full-stack сервисов.",
          timestamp: new Date().toISOString()
        },
        {
          id: "seed-loop",
          category: "Исправление Ошибок",
          title: "Защита от зацикливания",
          details: "При отладке сложных скриптов агент должен использовать постепенный запуск и проверять логи. Не запускать бесконечные фоновые циклы без вывода в файл.",
          timestamp: new Date().toISOString()
        }
      ];
      await fs.writeFile(LESSONS_FILE, JSON.stringify(defaultLessons, null, 2), "utf-8");
      console.log("Memory database seeded with initial lessons.");
    }

    // Seed default custom tools manifest if missing
    try {
      await fs.access(CUSTOM_TOOLS_MANIFEST);
    } catch {
      await fs.writeFile(CUSTOM_TOOLS_MANIFEST, JSON.stringify([], null, 2), "utf-8");
      console.log("Custom tools database initialized.");
    }
  } catch (err) {
    console.error("Failed to initialize system folders:", err);
  }
};
initDirectories();

// Memory CRUD operations
async function get_lessons(): Promise<any[]> {
  try {
    const raw = await fs.readFile(LESSONS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function get_custom_tools(): Promise<any[]> {
  try {
    const raw = await fs.readFile(CUSTOM_TOOLS_MANIFEST, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function execute_custom_tool(tool: any, args: any): Promise<string> {
  try {
    const scriptPath = path.isAbsolute(tool.script) 
      ? tool.script 
      : path.resolve(process.cwd(), tool.script);
      
    // Verify file exists
    try {
      await fs.access(scriptPath);
    } catch {
      return `Ошибка: Не найден исполняемый скрипт для инструмента '${tool.name}' по адресу: ${tool.script}`;
    }

    const argsJsonString = JSON.stringify(args);
    const escapedArgs = argsJsonString.replace(/'/g, "'\\''");

    let cmd = "";
    if (scriptPath.endsWith(".py")) {
      cmd = `python3 "${scriptPath}" '${escapedArgs}'`;
    } else if (scriptPath.endsWith(".js")) {
      cmd = `node "${scriptPath}" '${escapedArgs}'`;
    } else if (scriptPath.endsWith(".sh")) {
      cmd = `bash "${scriptPath}" '${escapedArgs}'`;
    } else {
      cmd = `"${scriptPath}" '${escapedArgs}'`;
    }

    console.log(`[Custom Tool Factory] Running tool '${tool.name}' via command: ${cmd}`);
    
    const { stdout, stderr } = await execAsync(cmd, { timeout: 60000 });
    
    let result = stdout || "";
    if (stderr && stderr.trim()) {
      result += `\n[Логи/Stderr ошибки]:\n${stderr}`;
    }
    
    return result.trim() === "" ? "[Успешно: Скрипт завершился без вывода]" : result;
  } catch (err: any) {
    console.error(`Error executing custom tool ${tool.name}:`, err);
    return `Ошибка запуска пользовательского инструмента ${tool.name}: ${err.message}${err.stdout ? `\nStdout:\n${err.stdout}` : ""}${err.stderr ? `\nStderr:\n${err.stderr}` : ""}`;
  }
}

async function add_lesson_record(category: string, title: string, details: string): Promise<any> {
  const list = await get_lessons();
  const index = list.findIndex(l => l.title.trim().toLowerCase() === title.trim().toLowerCase());
  
  const newItem = {
    id: `lesson-${Date.now()}`,
    category,
    title,
    details,
    timestamp: new Date().toISOString()
  };

  if (index !== -1) {
    // Override lesson with new findings
    list[index] = { ...list[index], ...newItem, id: list[index].id };
  } else {
    list.push(newItem);
  }
  
  await fs.writeFile(LESSONS_FILE, JSON.stringify(list, null, 2), "utf-8");
  return newItem;
}

// Define Superagent TOOLS
const DEEPSEEK_TOOLS = [
  {
    "type": "function",
    "function": {
      "name": "read_file",
      "description": "Прочесть содержимое текстового файла на сервере. Принимает относительный или абсолютный путь.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Путь к целевому файлу для чтения"
          }
        },
        "required": ["path"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "write_file",
      "description": "Записать данные (текст, код) в файл на сервере. Автоматически создает папки при необходимости.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Путь к сохраняемому файлу"
          },
          "content": {
            "type": "string",
            "description": "Текстовое содержимое файла"
          }
        },
        "required": ["path", "content"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "run_command",
      "description": "Выполнить терминальную команду (shell-команду) на сервере VPS. Возвращает stdout и stderr.",
      "parameters": {
        "type": "object",
        "properties": {
          "command": {
            "type": "string",
            "description": "Команда для выполнения в bash / sh"
          }
        },
        "required": ["command"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "web_search",
      "description": "Поиск свежей, актуальной информации в интернете по любому запросу.",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "Текст поискового запроса"
          }
        },
        "required": ["query"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "scrape_url",
      "description": "Импортировать текстовое содержимое веб-страницы по предоставленному URL.",
      "parameters": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "description": "Прямой URL-адрес для загрузки текста"
          }
        },
        "required": ["url"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "memorize_lesson",
      "description": "Запомнить новый изученный факт, исправленную системную ошибку или полезное знание о VPS сервере или предпочтениях пользователя во внутреннюю базу знаний. Позволяет агенту САМООБУЧАТЬСЯ.",
      "parameters": {
        "type": "object",
        "properties": {
          "category": {
            "type": "string",
            "enum": ["VPS Конфигурация", "Исправление Ошибок", "Системная команда", "Пользовательские факты"],
            "description": "Классификация полученного опыта"
          },
          "title": {
            "type": "string",
            "description": "Краткое понятное название вынесенного урока"
          },
          "details": {
            "type": "string",
            "description": "Полное описание факта, решение ошибки, код или команды, которые нужно сохранить."
          }
        },
        "required": ["category", "title", "details"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "document_rag_search",
      "description": "Умное индексирование и локальный семантический RAG поиск по большим текстовым файлам/документам (спецификации, логи, базы кодов) без переполнения контекста модели.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Путь к индексируемому файлу на сервере"
          },
          "query": {
            "type": "string",
            "description": "Поисковый запрос с ключевыми словами или фразой для семантического ранжирования фрагментов"
          }
        },
        "required": ["path", "query"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "delegate_task_to_model",
      "description": "ЭКСКЛЮЗИВНЫЙ ИНСТРУМЕНТ: Делегировать подзадачу (например, дизайн-анализ, сложное кодирование, исследование или написание текстов) специализированной модели ИИ через шлюз RouterAI под капотом. Рекомендуемые модели: 'anthropic/claude-3-5-sonnet' (для сложного кода/рефакторинга), 'openai/gpt-4o' (для креатива, дизайна и структуры), 'google/gemini-2.5-pro' (для глубоких исследований больших файлов/данных), 'deepseek/deepseek-r1' (для сложной математики и логического рассуждения), 'google/gemini-2.5-flash' (для простых рутинных задач, быстрого суммирования). Возвращает ответ выбранной модели.",
      "parameters": {
        "type": "object",
        "properties": {
          "model": {
            "type": "string",
            "description": "Идентификатор модели в RouterAI (например, 'anthropic/claude-3-5-sonnet', 'openai/gpt-4o', 'google/gemini-2.5-pro', 'deepseek/deepseek-r1', 'google/gemini-2.5-flash', 'openai/gpt-4o-mini', 'deepseek/deepseek-chat')"
          },
          "prompt": {
            "type": "string",
            "description": "Текст задания (все исходные данные, контекст, ссылки, ТЗ и инструкции)"
          },
          "system_instruction": {
            "type": "string",
            "description": "Необязательная системная инсталляция для делегируемой модели (ее роль, ограничения вывода)"
          }
        },
        "required": ["model", "prompt"]
      }
    }
  }
];

// Tool Implementation Logic
async function delegate_task_to_model_tool(model: string, prompt: string, system_instruction?: string, routerKey?: string): Promise<string> {
  const finalRouterKey = routerKey || process.env.ROUTER_API_KEY || "";
  const hasRouter = finalRouterKey && finalRouterKey.trim() !== "" && !finalRouterKey.includes("MY_ROUTER_API_KEY");

  if (!hasRouter) {
    // Attempt fallback to Gemini API if direct key is available
    const geminiKey = process.env.GEMINI_API_KEY || "";
    if (geminiKey && geminiKey.trim() !== "" && !geminiKey.includes("MY_GEMINI_API_KEY")) {
      try {
        console.log(`[Delegation Fallback] No RouterAI API key. Delegating task to direct Gemini model...`);
        const client = getGeminiClient(geminiKey);
        const systemText = system_instruction || "";
        const response = await client.models.generateContent({
          model: "gemini-3.5-flash",
          contents: prompt,
          config: {
            systemInstruction: systemText,
            temperature: 0.6,
          }
        });
        return `[ПРИМЕЧАНИЕ: Выполнен автоматический фоллбэк на прямую Gemini 3.5 Flash из-за ненастроенного ROUTER_API_KEY]\n\n[ОТВЕТ МОДЕЛИ]:\n${response.text || ""}`;
      } catch (geminiErr: any) {
        return `Ошибка фоллбэка на Gemini: ${geminiErr.message}`;
      }
    }
    return "Ошибка: Для использования делегирования моделей настройте ROUTER_API_KEY или GEMINI_API_KEY в Secrets.";
  }

  try {
    console.log(`[Delegation Tool] Sending task to model "${model}"... Prompt length: ${prompt.length}`);
    const messages: any[] = [];
    if (system_instruction) {
      messages.push({ role: "system", content: system_instruction });
    }
    messages.push({ role: "user", content: prompt });

    const response = await fetch("https://routerai.ru/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${finalRouterKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: model.includes("r1") || model.includes("reasoning") ? 1.0 : 0.6,
      })
    });

    if (!response.ok) {
      const rawErr = await response.text();
      return `Ошибка делегирования модели ${model} (RouterAI статус ${response.status}): ${rawErr}`;
    }

    const data: any = await response.json();
    const resultText = data?.choices?.[0]?.message?.content || "";
    const reasoningText = data?.choices?.[0]?.message?.reasoning_content || "";

    let finalOutput = "";
    if (reasoningText) {
      finalOutput += `[МЫШЛЕНИЕ МОДЕЛИ]:\n${reasoningText}\n\n`;
    }
    finalOutput += `[ОТВЕТ МОДЕЛИ]:\n${resultText}`;

    console.log(`[Delegation Tool] Received response from "${model}". Response length: ${finalOutput.length}`);
    return finalOutput;
  } catch (err: any) {
    return `Исключение при обращении к модели ${model}: ${err.message}`;
  }
}

async function get_text_embedding(text: string, routerKey?: string, geminiKey?: string): Promise<number[] | null> {
  const hasRouter = routerKey && routerKey.trim() !== "";
  const hasGemini = geminiKey && geminiKey.trim() !== "";
  
  if (hasRouter) {
    try {
      const response = await fetch("https://routerai.ru/api/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${routerKey}`
        },
        body: JSON.stringify({
          model: "openai/text-embedding-3-small",
          input: text
        })
      });
      if (response.ok) {
        const data: any = await response.json();
        const emb = data?.data?.[0]?.embedding;
        if (emb && Array.isArray(emb)) return emb;
      }
    } catch (e) {
      console.warn("[Embedding API] RouterAI embed failed, trying Gemini fallback:", e);
    }
  }

  if (hasGemini) {
    try {
      const ai = getGeminiClient(geminiKey);
      const response = await ai.models.embedContent({
        model: "text-embedding-004",
        contents: text
      });
      const emb = (response as any).embedding?.values;
      if (emb && Array.isArray(emb)) return emb;
    } catch (e) {
      console.warn("[Embedding API] Gemini embed failed:", e);
    }
  }

  return null;
}

function cosine_similarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) return 0;
  let dotProduct = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function update_shared_memory(activeMessages: any[], routerKey?: string, geminiKey?: string) {
  try {
    const hasRouter = routerKey && routerKey.trim() !== "";
    const hasGemini = geminiKey && geminiKey.trim() !== "";
    if (!hasRouter && !hasGemini) return;

    const memoryPath = path.join(process.cwd(), "data", "memory.md");
    await fs.mkdir(path.join(process.cwd(), "data"), { recursive: true });

    let existingMemory = "";
    try {
      existingMemory = await fs.readFile(memoryPath, "utf-8");
    } catch {
      // Ignored
    }

    const recentMessages = activeMessages.slice(-10);
    const recentHistoryStr = recentMessages.map((m: any) => `${m.role}: ${m.content || ""}`).join("\n");

    const memoryPrompt = `Владелец бизнеса внес изменения или обсудил проект. Обнови файл долговременной памяти memory.md.
Текущее содержание memory.md:
"""
${existingMemory || "Память пуста."}
"""

Свежие события диалога:
"""
${recentHistoryStr}
"""

На основе этих данных сформируй обновленную версию файла memory.md на русском языке.
Сохраняй:
1. Основные предпочтения пользователя, профиль бизнеса и цели.
2. Краткий статус проекта, стек технологий, созданные файлы, запущенные на VPS службы.
3. Важные технические решения (например, как решена проблема с Docker, пути к файлам вроде /host/..., права доступа и т.д.).
Верни ТОЛЬКО чистый markdown-текст обновленного memory.md, без каких-либо обратных кавычек \`\`\` или пояснений. Это готовый файл.`;

    let updatedContent = "";
    if (hasRouter) {
      try {
        const response = await fetch("https://routerai.ru/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${routerKey}`
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [{ role: "user", content: memoryPrompt }],
            temperature: 0.2
          })
        });
        if (response.ok) {
          const data: any = await response.json();
          updatedContent = data?.choices?.[0]?.message?.content || "";
        }
      } catch (err) {
        console.warn("[Memory Sync Background] RouterAI update failed:", err);
      }
    }

    if (!updatedContent && hasGemini) {
      try {
        const ai = getGeminiClient(geminiKey);
        const resp = await ai.models.generateContent({
          model: "gemini-3.5-flash",
          contents: memoryPrompt,
          config: { temperature: 0.2 }
        });
        updatedContent = resp.text || "";
      } catch (err) {
        console.warn("[Memory Sync Background] Gemini update failed:", err);
      }
    }

    if (updatedContent && updatedContent.trim() !== "") {
      let cleanContent = updatedContent.trim();
      if (cleanContent.startsWith("```markdown")) {
        cleanContent = cleanContent.substring(11);
      } else if (cleanContent.startsWith("```")) {
        cleanContent = cleanContent.substring(3);
      }
      if (cleanContent.endsWith("```")) {
        cleanContent = cleanContent.substring(0, cleanContent.length - 3);
      }
      cleanContent = cleanContent.trim();

      await fs.writeFile(memoryPath, cleanContent, "utf-8");
      try {
        await fs.writeFile(path.join(process.cwd(), "memory.md"), cleanContent, "utf-8");
      } catch (e) {
        // Ignored
      }
      console.log("[Memory Sync Background] Successfully updated and persisted memory.md.");
    }
  } catch (err) {
    console.error("[Memory Sync Background] Fatal memory sync error:", err);
  }
}

async function document_rag_search_tool(filePath: string, query: string, routerKey?: string, geminiKey?: string): Promise<string> {
  try {
    const target = translatePath(filePath);
    const statFiles = await fs.stat(target);
    const fileMtime = statFiles.mtimeMs;
    const text = await fs.readFile(target, "utf-8");
    
    if (!text || text.trim() === "") {
      return `Документ ${filePath} пуст.`;
    }

    if (text.length <= 6000) {
      return `[Документ малого объема. Возвращен весь текст для прямого анализа]:\n\n--- СОДЕРЖИМОЕ ФАЙЛА ${filePath} ---\n${text}`;
    }

    // Smart Chunking Layout: split into blocks of ~1000 chars with overlapping (~200 chars)
    const chunkSize = 1000;
    const overlap = 200;
    const chunks: { index: number; content: string; startLine: number; endLine: number }[] = [];
    
    const lines = text.split("\n");
    let currentLineIndex = 1;

    for (let i = 0; i < text.length; ) {
      const end = Math.min(i + chunkSize, text.length);
      const chunkText = text.substring(i, end);
      
      const chunkLinesCount = chunkText.split("\n").length - 1;
      const startLine = currentLineIndex;
      const endLine = currentLineIndex + chunkLinesCount;

      chunks.push({
        index: chunks.length + 1,
        content: chunkText,
        startLine,
        endLine
      });

      const step = chunkSize - overlap;
      const stepText = text.substring(i, Math.min(i + step, text.length));
      const stepLinesCount = stepText.split("\n").length - 1;
      currentLineIndex += stepLinesCount;
      
      i += step;
      if (i >= text.length - overlap) break;
    }

    // Attempt to parse existing caching mechanism for embeddings
    const cachePath = `${target}.embeddings.json`;
    let cachedData: { fileMtime: number; chunks: any[] } | null = null;
    let cacheValid = false;

    try {
      if (existsSync(cachePath)) {
        const cacheRaw = await fs.readFile(cachePath, "utf-8");
        cachedData = JSON.parse(cacheRaw);
        if (cachedData && cachedData.fileMtime === fileMtime && cachedData.chunks.length === chunks.length) {
          cacheValid = true;
          console.log(`[RAG Embedding Engine] Cache HIT for file: ${filePath}`);
        }
      }
    } catch (e) {
      console.warn("[RAG Embedding Engine] Cache read issue:", e);
    }

    // Compute query embedding
    const queryEmb = await get_text_embedding(query, routerKey, geminiKey);
    
    if (queryEmb && (routerKey || geminiKey)) {
      console.log(`[RAG Embedding Engine] Performing semantic embedding-based retrieval for "${query}"...`);
      
      // Compute missing chunks embeddings if cache invalid
      const finalChunksWithEmbeddings: any[] = [];
      if (cacheValid && cachedData) {
        finalChunksWithEmbeddings.push(...cachedData.chunks);
      } else {
        console.log(`[RAG Embedding Engine] Cache MISS. Building embeddings for ${chunks.length} chunks...`);
        // Limit batch concurrent execution to prevent API rate limit issues
        for (let idx = 0; idx < chunks.length; idx++) {
          const chunk = chunks[idx];
          const emb = await get_text_embedding(chunk.content, routerKey, geminiKey);
          finalChunksWithEmbeddings.push({
            ...chunk,
            embedding: emb || []
          });
        }
        
        // Write back to cache
        try {
          await fs.writeFile(cachePath, JSON.stringify({
            fileMtime,
            chunks: finalChunksWithEmbeddings
          }, null, 2), "utf-8");
          console.log(`[RAG Embedding Engine] Embeddings successfully stored in cache at "${filePath}.embeddings.json".`);
        } catch (cwErr) {
          console.warn("[RAG Embedding Engine] Cache writing failed:", cwErr);
        }
      }

      // Rank chunks using true Cosine Similarity
      const scoredChunks = finalChunksWithEmbeddings.map(chunk => {
        let score = 0;
        if (chunk.embedding && chunk.embedding.length > 0) {
          score = cosine_similarity(queryEmb, chunk.embedding);
        } else {
          // Fallback to local lexical keyword lookup score scaled down
          const chunkLower = chunk.content.toLowerCase();
          if (chunkLower.includes(query.toLowerCase().trim())) {
            score = 0.5;
          }
        }
        return { chunk, score };
      });

      scoredChunks.sort((a, b) => b.score - a.score);

      const finalMatches = scoredChunks.slice(0, 4);

      let result = `=== РЕЗУЛЬТАТЫ СЕМАНТИЧЕСКОГО СЛУЖЕБНОГО ПОИСКА RAG (ВЕКТОРНЫЕ ЭМБЕДДИНГИ): "${query}" ===\n`;
      result += `Файл: ${filePath}\n`;
      result += `Всего проиндексировано сегментов: ${chunks.length}\n`;
      result += `Использован движок: ${routerKey ? "RouterAI (openai/text-embedding-3-small)" : "Gemini (text-embedding-004)"}\n\n`;

      finalMatches.forEach((m, idx) => {
        result += `[ФРАГМЕНТ #${idx + 1} (Векторное сходство: ${(m.score * 100).toFixed(2)}%, Строки: ${m.chunk.startLine}-${m.chunk.endLine})]\n`;
        result += `--------------------------------------------------------\n`;
        result += m.chunk.content.trim() + `\n`;
        result += `--------------------------------------------------------\n\n`;
      });

      return result;
    }

    // Default Token/Fallback Tokenize search
    console.log(`[RAG Fallback Engine] Embedding keys unavailable. Utilizing smart keyword matching...`);
    const queryTokens = query
      .toLowerCase()
      .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, " ")
      .split(/\s+/)
      .filter(t => t.length > 1 && !["и", "в", "на", "как", "не", "что", "чтобы", "это", "этот", "для", "по", "из", "с", "а", "но", "или", "the", "a", "of", "to", "and", "in", "is"].includes(t));

    if (queryTokens.length === 0) {
      queryTokens.push(...query.toLowerCase().split(/\s+/).filter(t => t.length > 0));
    }

    // Rank chunks
    const scoredChunks = chunks.map(chunk => {
      let score = 0;
      const contentLower = chunk.content.toLowerCase();
      
      const sanitizedQuery = query.toLowerCase().trim();
      if (contentLower.includes(sanitizedQuery)) {
        score += 150;
      }

      for (const token of queryTokens) {
        if (token.length < 2) continue;
        let count = 0;
        let pos = contentLower.indexOf(token);
        while (pos !== -1) {
          count++;
          pos = contentLower.indexOf(token, pos + token.length);
        }
        if (count > 0) {
          score += (count * 10) + (token.length * 4);
        }
      }

      return { chunk, score };
    });

    scoredChunks.sort((a, b) => b.score - a.score);

    const topMatches = scoredChunks.filter(m => m.score > 0).slice(0, 4);
    const finalMatches = topMatches.length > 0 ? topMatches : scoredChunks.slice(0, 3);
    
    let result = `=== РЕЗУЛЬТАТЫ СЕМАНТИЧЕСКОГО СЛУЖЕБНОГО ПОИСКА RAG: "${query}" ===\n`;
    result += `Файл: ${filePath}\n`;
    result += `Всего проиндексировано сегментов: ${chunks.length}\n\n`;

    finalMatches.forEach((m, idx) => {
      result += `[ФРАГМЕНТ #${idx + 1} (Релевантность: ${m.score} баллов, Строки: ${m.chunk.startLine}-${m.chunk.endLine})]\n`;
      result += `--------------------------------------------------------\n`;
      result += m.chunk.content.trim() + `\n`;
      result += `--------------------------------------------------------\n\n`;
    });

    if (finalMatches.length === 0 || finalMatches[0].score === 0) {
      result += `[Предупреждение]: Точные совпадения по ключевым словам не обнаружены. Рекомендуется повторить поиск с более общими терминами, либо прочитать файл целиком с помощью 'read_file'.\n`;
    }

    return result;
  } catch (err: any) {
    return `Ошибка индексирования или RAG-поиска по файлу: ${err.message}`;
  }
}

async function read_file_tool(filePath: string): Promise<string> {
  try {
    const target = translatePath(filePath);
    const text = await fs.readFile(target, "utf-8");
    return `--- СОДЕРЖИМОЕ ФАЙЛА ${filePath} ---\n${text}`;
  } catch (err: any) {
    return `Ошибка чтения файла: ${err.message}`;
  }
}

async function write_file_tool(filePath: string, content: string): Promise<string> {
  try {
    const target = translatePath(filePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf-8");
    return `Файл "${filePath}" успешно создан/записан.`;
  } catch (err: any) {
    return `Ошибка записи файла: ${err.message}`;
  }
}

async function run_command_tool(command: string): Promise<string> {
  try {
    console.log(`Executing terminal command: "${command}"`);
    const { stdout, stderr } = await execAsync(command, { timeout: 30000 });
    let output = "";
    if (stdout && stdout.trim()) output += stdout;
    if (stderr && stderr.trim()) output += `\n[STDERR]:\n${stderr}`;
    return output.trim() || "[Команда завершена без текстового вывода]";
  } catch (err: any) {
    let output = `Ошибка выполнения (${err.code || "Status Error"}): ${err.message}`;
    if (err.stdout) output += `\n[STDOUT]:\n${err.stdout}`;
    if (err.stderr) output += `\n[STDERR]:\n${err.stderr}`;
    return output;
  }
}

async function web_search_tool(query: string): Promise<string> {
  try {
    console.log(`Searching DuckDuckGo for: "${query}"`);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    
    if (!resp.ok) {
      throw new Error(`Поисковик вернул статус ${resp.status}`);
    }
    
    const html = await resp.text();
    const results: { title: string; snippet: string; link: string }[] = [];
    
    const parts = html.split('class="result results_links');
    for (let i = 1; i < Math.min(parts.length, 6); i++) {
      const part = parts[i];
      
      const titleMatch = part.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
      const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, "").trim() : "Без названия";
      
      const linkMatch = part.match(/href="([^"]*)"/);
      let link = linkMatch ? linkMatch[1] : "";
      if (link.startsWith("//")) link = "https:" + link;
      
      const snippetMatch = part.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, "").trim() : "";
      
      if (snippet || title) {
        results.push({ title, snippet, link });
      }
    }
    
    if (results.length === 0) {
      return "Результаты поиска не найдены. Сформулируйте запрос иначе.";
    }
    
    return results.map((r, i) => `[${i + 1}] [${r.title}](${r.link})\n${r.snippet}`).join("\n\n");
  } catch (err: any) {
    console.error("Search failure:", err);
    return `Не удалось выполнить поиск в сети: ${err.message}`;
  }
}

async function scrape_url_tool(targetUrl: string): Promise<string> {
  try {
    console.log(`Scraping text content from: ${targetUrl}`);
    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    
    if (!response.ok) {
      return `Ошибка HTTP: ${response.status} ${response.statusText}`;
    }
    
    const html = await response.text();
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<\/?[^>]+(>|$)/g, " ")
      .replace(/\s+/g, " ")
      .trim();
      
    return text.slice(0, 5000) || "[Пустая страница или не удалось извлечь читаемый текст]";
  } catch (err: any) {
    return `Ошибка парсинга страницы: ${err.message}`;
  }
}

function isBufferPlainText(buf: Buffer): boolean {
  if (buf.length === 0) return true;
  const checkLimit = Math.min(buf.length, 1024);
  let binaryChars = 0;
  for (let i = 0; i < checkLimit; i++) {
    const byte = buf[i];
    if (byte === 0) return false; // Null byte indicates binary
    if (byte < 7 || (byte > 14 && byte < 32)) {
      binaryChars++;
    }
  }
  return (binaryChars / checkLimit) < 0.1;
}

async function parseFileToText(name: string, mimeType: string, base64Data: string): Promise<string> {
  const buf = Buffer.from(base64Data, "base64");
  const ext = name.split(".").pop()?.toLowerCase() || "";

  // 1. PDF files
  if (mimeType === "application/pdf" || ext === "pdf") {
    try {
      const data = await pdf(buf);
      return `[Содержимое файла PDF "${name}"]: \n${data.text || ""}`;
    } catch (e: any) {
      console.warn(`[PDF Parse Error] Failed to parse PDF: ${e.message}`);
      return `[Ошибка при извлечении текста из PDF "${name}"]: ${e.message}`;
    }
  }

  // 2. Word documents (.docx)
  if (mimeType.includes("word") || ext === "docx") {
    try {
      const result = await mammoth.extractRawText({ buffer: buf });
      return `[Содержимое файла Word "${name}"]: \n${result.value || ""}`;
    } catch (e: any) {
      console.warn(`[Word Parse Error] Failed to parse DOCX: ${e.message}`);
      return `[Ошибка при извлечении текста из документа Word "${name}"]: ${e.message}`;
    }
  }

  // 3. Excel sheets & CSV (.xlsx, .xls, .csv, .tsv)
  if (
    mimeType.includes("sheet") || 
    mimeType.includes("ms-excel") || 
    mimeType.includes("csv") || 
    ["xlsx", "xls", "csv", "tsv"].includes(ext)
  ) {
    try {
      const workbook = XLSX.read(buf, { type: "buffer" });
      let sheetTexts: string[] = [];
      for (const sheetName of workbook.SheetNames) {
        const worksheet = workbook.Sheets[sheetName];
        const csvContent = XLSX.utils.sheet_to_csv(worksheet);
        sheetTexts.push(`--- Лист "${sheetName}" ---\n${csvContent}`);
      }
      return `[Содержимое таблицы "${name}"]: \n${sheetTexts.join("\n\n")}`;
    } catch (e: any) {
      console.warn(`[Excel Parse Error] Failed to parse workbook: ${e.message}`);
      return `[Ошибка при извлечении данных из таблицы "${name}"]: ${e.message}`;
    }
  }

  // 4. Standard text or source code files
  const isTextLike = mimeType.startsWith("text/") || 
                     mimeType.includes("json") || 
                     mimeType.includes("xml") || 
                     mimeType.includes("javascript") || 
                     mimeType.includes("typescript") ||
                     mimeType.includes("yaml") ||
                     mimeType.includes("markdown") ||
                     [
                       "py", "js", "ts", "tsx", "jsx", "json", "yml", "yaml", "html", "css", 
                       "sh", "bash", "conf", "ini", "md", "txt", "log", "sql", "env", "cfg",
                       "properties", "java", "c", "cpp", "h", "hpp", "cs", "go", "rs", "swift",
                       "kt", "php", "rb", "pl", "pm", "r", "m", "dockerfile", "makefile", "gitignore"
                     ].includes(ext);

  if (isTextLike) {
    try {
      return `[Содержимое текстового файла "${name}"]: \n${buf.toString("utf-8")}`;
    } catch (e: any) {
      console.warn(`[Text Match parse error] failed: ${e.message}`);
    }
  }

  // Smart plain-text fallback content check
  try {
    const isTxt = isBufferPlainText(buf);
    if (isTxt) {
      return `[Содержимое текстового файла "${name}" (определен как текст)]: \n${buf.toString("utf-8")}`;
    }
  } catch (e) {
    // ignore
  }

  return `[Вложенный файл: ${name} (тип: ${mimeType || "unknown"}) - двоичный формат, прямое распознавание текста не поддерживается]`;
}

/**
 * Helper function to format chat history for OpenAI-compatibility with vision capabilities
 */
function formatOpenAIMessages(loopMessages: any[], activeModel: string): any[] {
  const modelLower = activeModel.toLowerCase();
  
  // High-performance models on RouterAI or OpenAI/Anthropic/Gemini that support standard OpenAI multimodal schema
  const supportsVision = modelLower.includes("gpt") || 
                         modelLower.includes("claude") || 
                         modelLower.includes("gemini") || 
                         modelLower.includes("vision") || 
                         modelLower.includes("lba") || 
                         modelLower.includes("pixtral");

  return loopMessages.map((m: any) => {
    let textContent = m.content || "";
    const files = m.files || [];
    
    if (files.length === 0) {
      if (m.tool_calls) {
        return {
          role: m.role,
          content: textContent || null,
          tool_calls: m.tool_calls,
          name: m.name,
          tool_call_id: m.tool_call_id,
        };
      }
      return {
        role: m.role,
        content: textContent,
        name: m.name,
        tool_call_id: m.tool_call_id,
      };
    }

    const imageFiles = files.filter((f: any) => f.type && f.type.startsWith("image/"));
    const nonImageFiles = files.filter((f: any) => !f.type || !f.type.startsWith("image/"));

    // Compile text prefix with non-image files listed as info and decrypted contents
    let customText = textContent;
    if (nonImageFiles.length > 0) {
      const fileExcerpts = nonImageFiles.map((f: any) => {
        if (f.parsedText) {
          return f.parsedText;
        }
        return `[Вложенный файл: ${f.name} (тип: ${f.type || "unknown"}) - двоичный формат, содержимое скрыто]`;
      }).join("\n\n");
      
      customText = customText ? `${customText}\n\n${fileExcerpts}` : fileExcerpts;
    }

    // Format with image_url blocks if vision is supported and there are image attachments
    if (supportsVision && imageFiles.length > 0) {
      const contentArray: any[] = [];
      if (customText) {
        contentArray.push({ type: "text", text: customText });
      }
      for (const img of imageFiles) {
        contentArray.push({
          type: "image_url",
          image_url: {
            url: img.base64 // standard inline base64 string "data:image/jpeg;base64,..."
          }
        });
      }
      return {
        role: m.role,
        content: contentArray,
        tool_calls: m.tool_calls,
        name: m.name,
        tool_call_id: m.tool_call_id,
      };
    } else if (imageFiles.length > 0) {
      // Model doesn't support vision directly, so let's append image filenames
      const imageNames = imageFiles.map((f: any) => `[Вложенная картинка: ${f.name} (тип: ${f.type || "unknown"}) - изображение было опущено на сервере, так как выбранная модель не поддерживает Vision]`).join("\n");
      customText = customText ? `${customText}\n\n${imageNames}` : imageNames;
    }

    if (m.tool_calls) {
      return {
        role: m.role,
        content: customText || null,
        tool_calls: m.tool_calls,
        name: m.name,
        tool_call_id: m.tool_call_id,
      };
    }

    return {
      role: m.role,
      content: customText,
      name: m.name,
      tool_call_id: m.tool_call_id,
    };
  });
}

/**
 * Unified Chat Endpoint that directs to DeepSeek or Gemini API with Superagent tool-calling loop
 */
app.post("/api/chat", async (req, res): Promise<any> => {
  try {
    const { messages, deepThink, webSearch, model: requestedModel } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Некорректный запрос: требуется массив сообщений 'messages'." });
    }

    const deepseekKey = req.body.deepseekApiKey || req.headers["x-deepseek-key"] || process.env.DEEPSEEK_API_KEY;
    const geminiKey = req.body.geminiApiKey || req.headers["x-gemini-key"] || process.env.GEMINI_API_KEY;
    const routerKey = req.body.routerApiKey || req.headers["x-router-key"] || process.env.ROUTER_API_KEY;

    const hasDeepSeek = deepseekKey && deepseekKey.trim() !== "" && !deepseekKey.includes("MY_DEEPSEEK_API_KEY");
    const hasGemini = geminiKey && geminiKey.trim() !== "" && !geminiKey.includes("MY_GEMINI_API_KEY");
    const hasRouter = routerKey && routerKey.trim() !== "" && !routerKey.includes("MY_ROUTER_API_KEY");

    // --- MASSIVE HISTORICAL DATA TRUNCATION TO DEFUSE TOKEN EXPLOSION ---
    const optimizedMessages = messages.map((msg: any, idx: number) => {
      // Keep the last 2 messages fully pristine for ongoing context integrity
      if (idx >= messages.length - 2) {
        return msg;
      }
      
      const oMsg = { ...msg };
      
      // Truncate huge tool responses
      if (oMsg.role === "tool" && typeof oMsg.content === "string" && oMsg.content.length > 800) {
        oMsg.content = oMsg.content.substring(0, 800) + "\n\n... [Вывод инструмента усечен сервером для экономии токенов ассистента] ...";
      }

      // Truncate recorded tool outputs inside assistant message logs
      if (oMsg.toolCalls && Array.isArray(oMsg.toolCalls)) {
        oMsg.toolCalls = oMsg.toolCalls.map((tc: any) => {
          if (tc.output && typeof tc.output === "string" && tc.output.length > 800) {
            return {
              ...tc,
              output: tc.output.substring(0, 800) + "\n\n... [Вывод усечен для экономии памяти] ..."
            };
          }
          return tc;
        });
      }

      // Drop heavy base64 strings in historical files
      if (oMsg.files && Array.isArray(oMsg.files)) {
        oMsg.files = oMsg.files.map((f: any) => {
          if (f.base64 && f.base64.length > 500) {
            return {
              ...f,
              base64: "[Данные файла усечены для экономии ресурсов]"
            };
          }
          return f;
        });
      }
      return oMsg;
    });

    // --- ASYNCHRONOUSLY PRE-PARSE ALL ATTACHED FILES (PDF, WORD, EXCEL, TEXT) ---
    for (const msg of optimizedMessages) {
      if (msg.files && Array.isArray(msg.files)) {
        for (const file of msg.files) {
          if (file.base64 && typeof file.base64 === "string" && !file.parsedText && !file.base64.startsWith("[Данные")) {
            const match = file.base64.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              const mimeType = match[1];
              const base64Data = match[2];
              try {
                file.parsedText = await parseFileToText(file.name, mimeType, base64Data);
              } catch (parseError: any) {
                console.warn(`[Pre-parse] Error parsing file '${file.name}':`, parseError);
                file.parsedText = `[Ошибка парсинга файла "${file.name}"]: ${parseError.message || parseError}`;
              }
            }
          }
        }
      }
    }

    // --- SMART MEMORY LAYER / HISTORY OPTIMIZATION & COMPRESSION ---
    let totalChars = 0;
    for (const msg of optimizedMessages) {
      if (msg && typeof msg.content === "string") {
        totalChars += msg.content.length;
      }
    }

    console.log(`[Memory Indexer] Active context size: ${totalChars} chars over ${optimizedMessages.length} messages.`);

    // If context size triggers optimization threshold, compress intermediate history layers
    if (totalChars > 25000 || optimizedMessages.length > 14) {
      console.log("[Memory Indexer] Context limit warning. Executing automatic middle-history summarization...");
      try {
        const systemMessage = optimizedMessages.find((m: any) => m.role === "system");
        const startIndex = systemMessage ? 1 : 0;
        
        // Keep system parameters, the very first 2 messages, and the last 6 messages intact
        const middleStartIndex = startIndex + 2;
        const tailStartIndex = optimizedMessages.length - 6;

        if (tailStartIndex > middleStartIndex) {
          const headerMessages = optimizedMessages.slice(0, middleStartIndex);
          const middleMessages = optimizedMessages.slice(middleStartIndex, tailStartIndex);
          const tailMessages = optimizedMessages.slice(tailStartIndex);

          console.log(`[Memory Indexer] Compressing ${middleMessages.length} intermediate messages into a semantic summary...`);

          const summarizationPrompt = `История предыдущего диалога для сжатия:\n` + 
            middleMessages.map((m: any) => `${m.role === "user" ? "Пользователь" : m.role === "assistant" ? "Ассистент" : "Инструмент"}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n---\n") + 
            `\n\nСделай краткое научно-техническое саммари (сжатый отчет) этой переписки на русском языке. Укажи: какие файлы были созданы, какие команды запущены, текущий статус проекта, и основные договоренности. Верни ТОЛЬКО сжатую суть без лишнего шума. Формат: "[Сжатый архив истории диалога: ...]"`;

          let summary = "";

          // Attempt using RouterAI model for quick translation/summary
          if (hasRouter) {
            try {
              const sumResponse = await fetch("https://routerai.ru/api/v1/chat/completions", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${routerKey}`
                },
                body: JSON.stringify({
                  model: "google/gemini-2.5-flash",
                  messages: [{ role: "user", content: summarizationPrompt }],
                  temperature: 0.3
                })
              });
              if (sumResponse.ok) {
                const sumData: any = await sumResponse.json();
                summary = sumData?.choices?.[0]?.message?.content || "";
              }
            } catch (e) {
              console.error("[Memory Indexer] RouterAI summarization failed:", e);
            }
          }

          // Fallback to direct Gemini Flash if RouterAI failed or is configured out
          if (!summary && hasGemini) {
            try {
              const ai = getGeminiClient(geminiKey);
              const sumResp = await ai.models.generateContent({
                model: "gemini-3.5-flash",
                contents: summarizationPrompt,
                config: { temperature: 0.3 }
              });
              summary = sumResp.text || "";
            } catch (e) {
              console.error("[Memory Indexer] Gemini summarization failed:", e);
            }
          }

          if (summary && summary.trim() !== "") {
            console.log("[Memory Indexer] Middle context summarized successfully.");
            const compressedMessages = [
              ...headerMessages,
              {
                role: "system",
                content: `[СИСТЕМНЫЙ АРХИВ ПАМЯТИ: Средняя часть диалога была сжата для уменьшения потребления токенов. Сводка архивного контекста:\n${summary}\nУчти эти факты и продолженный прогресс в своей дальнейшей работе!]`
              },
              ...tailMessages
            ];
            optimizedMessages.splice(0, optimizedMessages.length, ...compressedMessages);
          } else {
            console.warn("[Memory Indexer] Summarization APIs offline or silent. Utilizing safe sliding window context pruning...");
            const compressedMessages = [
              ...headerMessages,
              {
                role: "system",
                content: `[АРХИВ ПАМЯТИ: Средняя часть переписки (сообщений: ${middleMessages.length}) скрыта для предотвращения переполнения контекста.]`
              },
              ...tailMessages
            ];
            optimizedMessages.splice(0, optimizedMessages.length, ...compressedMessages);
          }
        }
      } catch (optErr) {
        console.error("[Memory Indexer] Failed optimizing dialogue context:", optErr);
      }
    }

    const activeMessages = optimizedMessages;

    // --- COGNITIVE SEMANTIC ROUTING LAYER ---
    let provider: "DeepSeek" | "Gemini" | "RouterAI" = "DeepSeek";
    let activeModel = "";
    const isReasoning = !!deepThink;
    let modelSelection = requestedModel || "auto";

    // Detect images and force vision-capable model if the selected model does not support images
    const hasImages = activeMessages.some((m: any) => m.files && m.files.some((f: any) => f.type && f.type.startsWith("image/")));
    
    if (hasImages) {
      const selectedLower = modelSelection.toLowerCase();
      const isVisionCapable = selectedLower.includes("gemini") || 
                              selectedLower.includes("gpt") || 
                              selectedLower.includes("vision") || 
                              selectedLower === "auto";
      if (!isVisionCapable) {
        console.log(`[Cognitive Routing] Image detected but selected model '${modelSelection}' is text-only. Forcing auto-routing to prevent crash.`);
        modelSelection = "auto";
      }
    }

    // Extract last user message to assess model preferences
    const lastUserMessage = activeMessages.slice().reverse().find((m: any) => m.role === "user")?.content || "";
    let userRequestedModelPrefix = "";
    let userRequestedModelLabel = "";
    const lowerMsg = lastUserMessage.toLowerCase();

    if (lowerMsg.includes("дипсик") || lowerMsg.includes("deepseek") || lowerMsg.includes("ds")) {
      userRequestedModelPrefix = "deepseek";
      userRequestedModelLabel = "DeepSeek Cheap/Chat";
    } else if (lowerMsg.includes("gpt") || lowerMsg.includes("дпт") || lowerMsg.includes("openai") || lowerMsg.includes("гпт")) {
      userRequestedModelPrefix = "openai";
      userRequestedModelLabel = "GPT-4o";
    } else if (lowerMsg.includes("gemini") || lowerMsg.includes("гемини") || lowerMsg.includes("джемини") || lowerMsg.includes("флеш")) {
      userRequestedModelPrefix = "gemini";
      userRequestedModelLabel = "Gemini Flash";
    } else if (lowerMsg.includes("claude") || lowerMsg.includes("клод") || lowerMsg.includes("антропик")) {
      userRequestedModelPrefix = "claude";
      userRequestedModelLabel = "Claude 3.5 Sonnet";
    }

    // Identify task complexity level
    let containsComplexTask = false;
    let complexityReason = "";

    if (
      lowerMsg.includes("напиши") || 
      lowerMsg.includes("код") || 
      lowerMsg.includes("скрипт") || 
      lowerMsg.includes("исправь") || 
      lowerMsg.includes("ошибк") || 
      lowerMsg.includes("баг") || 
      lowerMsg.includes("vps") || 
      lowerMsg.includes("терминал") || 
      lowerMsg.includes("команд") || 
      lowerMsg.includes("создай") || 
      lowerMsg.includes("файл") ||
      lowerMsg.includes("выполни") ||
      lowerMsg.includes("запусти") ||
      lowerMsg.includes("сложн") ||
      isReasoning
    ) {
      containsComplexTask = true;
      complexityReason = "содержит написание или отладку кода, команды системного уровня VPS или глубокое рассуждение";
    }

    let routingSystemInstructionOverride = "";

    if (hasRouter) {
      provider = "RouterAI";
      
      if (modelSelection === "auto") {
        if (hasImages) {
          activeModel = containsComplexTask ? "openai/gpt-4o" : "google/gemini-2.5-flash";
          routingSystemInstructionOverride = `\n[ВНИМАНИЕ МАРШРУТИЗАЦИИ]: В вашем сообщении обнаружены изображения/файлы. Сервер автоматически перенаправил запрос на мультимодальную модель "${activeModel}" с поддержкой компьютерного зрения (Vision). Начни ответ с дружелюбного комментария: "Чувак, я вижу твою картинку! Под это дело я специально взял модель ${activeModel === "openai/gpt-4o" ? "GPT-4o (Vision)" : "Gemini 2.5 Flash (Vision)"}, чтобы всё отлично разглядеть."`;
        } else if (containsComplexTask) {
          // High complexity -> route to flagships: DeepSeek R1 or GPT-4o
          activeModel = userRequestedModelPrefix === "openai" ? "openai/gpt-4o" : "deepseek/deepseek-r1";
          
          if (userRequestedModelPrefix === "deepseek" && !lowerMsg.includes("reasoning") && !lowerMsg.includes("рассужд")) {
            routingSystemInstructionOverride = `\n[ВНИМАНИЕ МАРШРУТИЗАЦИИ]: Пользователь просил использовать стандартный дешевый DeepSeek, но задача крайне сложная (${complexityReason}). Поэтому роутер под капотом перенаправил запрос на мощную модель "deepseek/deepseek-r1" с глубоким мышлением. Обязательно в НАЧАЛЕ своего ответа прокомментируй это дружелюбно и непринужденно в стиле: "Чувак, нифига, задача сложная (связана с кодом/инфраструктурой), поэтому я задействовал глубокое рассуждение DeepSeek R1, а не простой чат!". Пожалуйста, скажи это ровно в таком дружеском тоне.`;
          } else if (userRequestedModelPrefix && userRequestedModelPrefix !== "deepseek") {
            routingSystemInstructionOverride = `\n[ВНИМАНИЕ МАРШРУТИЗАЦИИ]: Пользователь выбрал ${userRequestedModelLabel}, но задача сложная (${complexityReason}). Сервер автоматически перенаправил запрос на модель ${activeModel} для высочайшего качества. Прокомментируй это дружелюбно в начале ответа: "Чувак, задача довольно сложная, поэтому чтобы всё прошло идеально, я подключил мощную модель ${activeModel === "openai/gpt-4o" ? "GPT-4o" : "DeepSeek R1"}!".`;
          } else {
            routingSystemInstructionOverride = `\n[ВНИМАНИЕ МАРШРУТИЗАЦИИ]: Задача классифицирована как высокосложная (${complexityReason}). Сервер под капотом выбрал флагманскую модель "${activeModel}" для лучшего результата. Кратко обоснуй это решение пользователю в начале ответа в живом дружеском ключе.`;
          }
        } else {
          // Low complexity -> fast, lighter model
          activeModel = userRequestedModelPrefix === "openai" ? "openai/gpt-4o-mini" : 
                        (userRequestedModelPrefix === "deepseek" ? "deepseek/deepseek-chat" : "google/gemini-2.5-flash");
                         
          if (userRequestedModelPrefix) {
            routingSystemInstructionOverride = `\n[ВНИМАНИЕ МАРШРУТИЗАЦИИ]: Подтверждена простая задача. Сервер послушно задействовал выбранный тобой "${activeModel}". Сделай забавное замечание в начале ответа, например: "Класс, задача простая, поэтому с удовольствием юзаю ${userRequestedModelLabel}!"`;
          } else {
            routingSystemInstructionOverride = `\n[ВНИМАНИЕ МАРШРУТИЗАЦИИ]: Обычный легкий запрос. Сервер автоматически задействовал быстрой модель "${activeModel}".`;
          }
        }
      } else if (modelSelection === "gemini-3.5-flash") {
        activeModel = "google/gemini-3.5-flash";
      } else if (modelSelection === "deepseek-reasoning") {
        activeModel = "deepseek/deepseek-r1";
      } else if (modelSelection === "deepseek-chat") {
        activeModel = "deepseek/deepseek-chat";
      } else {
        activeModel = modelSelection;
      }
    } else {
      // Direct traditional provider configurations
      if (modelSelection === "auto") {
        if (hasImages && hasGemini) {
          provider = "Gemini";
          activeModel = "gemini-3.5-flash";
          routingSystemInstructionOverride = `\n[ВНИМАНИЕ МАРШРУТИЗАЦИИ]: В вашем сообщении обнаружены изображения. Сервер автоматически перенаправил запрос на модель Gemini ("${activeModel}"), так как она полностью поддерживает Vision. Дружелюбно скажи пользователю об этом в начале.`;
        } else if (hasDeepSeek) {
          provider = "DeepSeek";
          activeModel = isReasoning ? "deepseek-reasoning" : "deepseek-chat";
          
          if (userRequestedModelPrefix === "gemini") {
            routingSystemInstructionOverride = `\n[ВНИМАНИЕ МАРШРУТИЗАЦИИ]: Ты запущен на ${activeModel}. Пользователь просил Gemini, но ты используешь DeepSeek. Подшути в начале ответа: "Чувак, нифига, давай лучше на DeepSeek, тут задача поинтереснее будет!"`;
          }
        } else if (hasGemini) {
          provider = "Gemini";
          activeModel = "gemini-3.5-flash";
          
          if (userRequestedModelPrefix === "deepseek") {
            routingSystemInstructionOverride = `\n[ВНИМАНИЕ МАРШРУТИЗАЦИИ]: Ты запущен на Gemini. Пользователь просил DeepSeek, но его ключ не задан. Прокомментируй это дружелюбно: "Чувак, я бы с радостью взял Дипсик, но его API-ключ не настроен, поэтому летим на Gemini!"`;
          }
        } else {
          return res.status(400).json({
            error: "Ни один из ключей API (ROUTER_API_KEY, DEEPSEEK_API_KEY или GEMINI_API_KEY) не настроен. Пожалуйста, настройте хотя бы один в Secrets."
          });
        }
      } else if (modelSelection === "gemini-3.5-flash") {
        provider = "Gemini";
        activeModel = "gemini-3.5-flash";
        if (!hasGemini) {
          return res.status(400).json({ error: "Выбранная модель Gemini недоступна, так как GEMINI_API_KEY не задан." });
        }
      } else {
        provider = "DeepSeek";
        activeModel = modelSelection === "deepseek-reasoning" ? "deepseek-reasoning" : "deepseek-chat";
        if (!hasDeepSeek) {
          return res.status(400).json({ error: "Выбранная модель DeepSeek недоступна, так как DEEPSEEK_API_KEY не задан." });
        }
      }
    }

    console.log(`[Cognitive Routing] Provider: ${provider}, Model: ${activeModel}, Reasoning: ${isReasoning}`);

    let loopMessages: any[] = [];
    for (const m of activeMessages) {
      if (m.role === "assistant" && m.toolCalls && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
        // Reconstruct assistant message standard API tool_calls list
        const toolCallsList = m.toolCalls.map((tc: any, index: number) => ({
          id: `call-${m.id || Date.now()}-${index}`,
          type: "function",
          function: {
            name: tc.toolName,
            arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments)
          }
        }));

        loopMessages.push({
          role: "assistant",
          content: m.content || null,
          tool_calls: toolCallsList,
          files: m.files,
        });

        // Add corresponding tool responses in correct sequential order
        for (let i = 0; i < m.toolCalls.length; i++) {
          const tc = m.toolCalls[i];
          loopMessages.push({
            role: "tool",
            tool_call_id: `call-${m.id || Date.now()}-${i}`,
            name: tc.toolName,
            content: tc.output || ""
          });
        }
      } else {
        loopMessages.push({
          role: m.role,
          content: m.content,
          tool_calls: m.tool_calls,
          name: m.name,
          tool_call_id: m.tool_call_id,
          files: m.files,
        });
      }
    }

    // Inject Superagent core prompt
    const hasSystemInstruction = loopMessages.some(m => m.role === "system");
    let systemText = "";
    if (!hasSystemInstruction) {
      const lessons = await get_lessons();
      const lessonsBlock = lessons.length > 0
        ? `\n\nНиже представлены факты и уроки, которые ты сам успешно изучил и записал во внутреннюю память самообучения на этом сервере VPS:\n${lessons.map((l, idx) => `[Урок #${idx+1}] Тема: ${l.category} - ${l.title}\nДетали: ${l.details}`).join("\n\n")}`
        : "";

      let coreInstruction = `Ты — Ин-Кон (In-Con), корпоративный супер-мозг, высокотехнологичный Суперагент и полноценный ассистент-партнер владельца бизнеса, ориентированный на бизнес-девелопмент, стратегический рост и максимальную автоматизацию. Ты не просто чат, а интеллектуальный операционный слой компании, обладающий полным пониманием бизнес-процессов, инфраструктуры и целей.

Твои ключевые качества:
1. Инициативность и Проактивность: Ты стремишься приносить измеримую пользу бизнесу. Не жди пассивных указаний — предлагай решения, автоматизируй рутину, выявляй слабые места в процессах и коде, создавай инструменты для масштабирования.
2. Фокус на Результат: Каждый твой ответ, скрипт или действие должны работать безукоризненно и приближать владельца компании к его бизнес-целям.
3. Полная информированность и Системность: Ты умеешь анализировать огромные массивы информации о бизнесе и претворять их в рабочие алгоритмы.

Инфраструктура Самообучения и Рекурсивность (Твоя главная суперсила):
- Память и Извлечение уроков: Если ты изучил новые факты об инфраструктуре, сервере VPS или предпочтениях пользователя, обязательно извлеки этот урок и сохрани его во внутреннюю базу знаний через инструмент 'memorize_lesson'.
- Динамическая Фабрика Инструментов ('Самообогащение'): Если тебе не хватает встроенных инструментов (чтение/запись файлов, shell-команды, поиск, RAG-поиск) для решения сложной бизнес-задачи, ты можешь ДИНАМИЧЕСКИ создавать новые способности!
  * Как это работает под капотом: 
    1. Напиши исполняемый скрипт (Python-код, Node.js или Bash) с помощью инструмента 'write_file'. Скрипты сохраняй в каталог 'data/custom_tools/'.
    2. Зарегистрируй свой новый инструмент в файле манифеста 'data/custom_tools/manifest.json'. Добавь в манифест JSON-описание инструмента: его 'name', 'description', относительный путь к исполняемому 'script' и схему параметров 'parameters' (в формате JSON Schema).
    3. При следующем вызове или продолжении сессии этот инструмент мгновенно появится в твоем списке доступных функций. При его вызове сервер автоматически выполнит твой скрипт, передав аргументы в виде JSON.
- Делегирование и Оркестрация: Тебе доступен мощнейший инструмент 'delegate_task_to_model'. Декомпозируй комплексные задачи владельца бизнеса на подзадачи и делегируй их специализированным ИИ (дизайн/копирайтинг поручай 'openai/gpt-4o', сложный код — 'anthropic/claude-3-5-sonnet', глубокие рассуждения — 'deepseek/deepseek-r1'). Затем интегрируй их результаты в целостный стратегический ответ.

Общайся с владельцем бизнеса на уверенном, профессиональном русском языке. Действуй смело, пиши надежный код и используй все свои вычислительные и алгоритмические ресурсы для достижения целей компании.`;

      // Try dynamically loading instructions from agent.md in ./data/agent.md or ./agent.md
      try {
        let loadedInstructions = "";
        try {
          loadedInstructions = await fs.readFile(path.join(process.cwd(), "data", "agent.md"), "utf-8");
        } catch {
          try {
            loadedInstructions = await fs.readFile(path.join(process.cwd(), "agent.md"), "utf-8");
          } catch {
            // Ignored, fallback to coreInstruction
          }
        }
        if (loadedInstructions && loadedInstructions.trim().length > 0) {
          console.log(`[Superagent] Successfully loaded dynamic system instructions from agent.md file (${loadedInstructions.length} chars).`);
          coreInstruction = loadedInstructions.trim();
        }
      } catch (dynamicErr) {
        console.warn("[Superagent] Failed to load agent.md dynamically, using defaults:", dynamicErr);
      }

      // Load cross-session memory compiled in memory.md
      let memoryBlock = "";
      try {
        let memoryContent = "";
        try {
          memoryContent = await fs.readFile(path.join(process.cwd(), "data", "memory.md"), "utf-8");
        } catch {
          try {
            memoryContent = await fs.readFile(path.join(process.cwd(), "memory.md"), "utf-8");
          } catch {
            // Ignored
          }
        }
        if (memoryContent && memoryContent.trim().length > 0) {
          memoryBlock = `\n\n=== ДОЛГОВРЕМЕННАЯ ПАМЯТЬ АГЕНТА ИЗ ПРЕДЫДУЩИХ ДИАЛОГОВ (memory.md):\n${memoryContent.trim()}\n========================================\nУчти эти цели, статус и предпочтения во всех своих дальнейших решениях и новых чатах!`;
          console.log(`[Superagent] Successfully loaded shared memory blocks (${memoryContent.length} chars).`);
        }
      } catch (memErr) {
        console.warn("[Superagent] Failed to load shared memory.md file:", memErr);
      }

      systemText = isReasoning 
        ? `${coreInstruction}${memoryBlock}\n\nПоскольку сейчас активна модель с глубоким мышлением (Reasoning), отвечай максимально развернуто, структурируй свои цепочки рассуждений (thinking) и проводи глубокий стратегический анализ.`
        : `${coreInstruction}${memoryBlock}\n\nУ тебя есть встроенный набор инструментов автоматизации VPS: чтение/запись файлов, shell-вызовы, поиск, RAG-поиск и динамическое создание кастомных инструментов. Используй их проактивно при первой же необходимости для решения бизнес-задач пользователя.${lessonsBlock}`;

      if (routingSystemInstructionOverride) {
        systemText += routingSystemInstructionOverride;
      }

      loopMessages.unshift({
        role: "system",
        content: systemText
      });
    } else {
      const sysMsg = loopMessages.find(m => m.role === "system");
      if (sysMsg && routingSystemInstructionOverride) {
        sysMsg.content = (sysMsg.content || "") + routingSystemInstructionOverride;
      }
      systemText = sysMsg?.content || "";
    }

    let finalContent = "";
    let reasoningContent = "";
    let totalDuration = 0;
    const toolCallsRecorded: any[] = [];
    let completionNeeded = true;
    let iteration = 0;
    const maxIterations = 5;

    while (completionNeeded && iteration < maxIterations) {
      iteration++;
      console.log(`Superagent Loop Iteration ${iteration}... Provider: ${provider}, Model: ${activeModel}`);

      const startTime = Date.now();
      let hasToolCalls = false;
      let toolCallsToExecute: any[] = [];

      // Load dynamic custom tools
      const customTools = await get_custom_tools();
      const formattedCustomTools = customTools.map((t: any) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }
      }));
      const activeToolsList = [...DEEPSEEK_TOOLS, ...formattedCustomTools];

      if (provider === "RouterAI") {
        let response;
        try {
          const bodyPayload: any = {
            model: activeModel,
            messages: formatOpenAIMessages(loopMessages, activeModel),
            temperature: activeModel.includes("reasoning") ? 1.0 : 0.6,
          };

          // Enable tool-calling loop for normal chat models inside RouterAI
          if (!activeModel.includes("reasoning")) {
            bodyPayload.tools = activeToolsList;
            bodyPayload.tool_choice = "auto";
          }

          response = await fetch("https://routerai.ru/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${routerKey}`
            },
            body: JSON.stringify(bodyPayload)
          });

          if (!response.ok) {
            const rawErr = await response.text();
            console.error(`RouterAI API server error (${response.status}):`, rawErr);
            throw new Error(`Ошибка сервера RouterAI API (${response.status}): ${rawErr}`);
          }
        } catch (fetchErr: any) {
          console.error("RouterAI fetch error wrapper:", fetchErr);
          
          // Only fallback if the user has a custom Gemini API key configured in the browser
          const customGeminiKey = req.body.geminiApiKey || req.headers["x-gemini-key"];
          const hasCustomGemini = customGeminiKey && customGeminiKey.trim() !== "" && !customGeminiKey.includes("MY_GEMINI_API_KEY");
          
          if (hasCustomGemini) {
            console.warn("RouterAI failed to complete request. Falling back to CUSTOM Gemini Key...");
            provider = "Gemini";
            activeModel = "gemini-3.5-flash";
            iteration--;
            continue;
          }
          
          // Otherwise, bubble up the exact RouterAI API error to the user UI so they can see and debug it 
          throw new Error(`Сбой RouterAI (${fetchErr.message || fetchErr}). Резервный переход на общую модель Gemini заблокирован во избежание превышения лимитов. Пожалуйста, убедитесь в наличии баланса на аккаунте RouterAI и в корректности введённого API-ключа.`);
        }

        const data: any = await response.json();
        totalDuration += Math.round((Date.now() - startTime) / 1000);

        const choice = data?.choices?.[0]?.message;
        finalContent = choice?.content || "";
        if (choice?.reasoning_content) {
          reasoningContent = choice.reasoning_content;
        }

        hasToolCalls = choice?.tool_calls && choice.tool_calls.length > 0;
        if (hasToolCalls) {
          toolCallsToExecute = choice.tool_calls;
          loopMessages.push({
            role: "assistant",
            content: choice.content || null,
            tool_calls: choice.tool_calls
          } as any);
        }
      } else if (provider === "DeepSeek") {
        let response;
        try {
          const bodyPayload: any = {
            model: activeModel,
            messages: formatOpenAIMessages(loopMessages, activeModel),
            temperature: activeModel === "deepseek-reasoning" ? 1.0 : 0.6,
          };

          if (activeModel !== "deepseek-reasoning") {
            bodyPayload.tools = activeToolsList;
            bodyPayload.tool_choice = "auto";
          }

          response = await fetch("https://api.deepseek.com/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${deepseekKey}`
            },
            body: JSON.stringify(bodyPayload)
          });

          if (!response.ok) {
            const rawErr = await response.text();
            console.error(`DeepSeek API server error (${response.status}):`, rawErr);
            
            // If Gemini API is available, automatically fall back to avoid downtime (only if selection was 'auto')
            if (hasGemini && modelSelection === "auto") {
              console.warn(`DeepSeek API returned error code ${response.status}. Falling back to Gemini...`);
              provider = "Gemini";
              activeModel = "gemini-3.5-flash";
              iteration--;
              continue;
            }
            throw new Error(`Ошибка сервера DeepSeek API (${response.status}): ${rawErr}`);
          }
        } catch (fetchErr: any) {
          console.error("DeepSeek fetch error wrapper:", fetchErr);
          if (hasGemini && modelSelection === "auto") {
            console.warn("DeepSeek offline or failed. Falling back to Gemini...");
            provider = "Gemini";
            activeModel = "gemini-3.5-flash";
            iteration--;
            continue;
          }
          throw fetchErr;
        }

        const data: any = await response.json();
        totalDuration += Math.round((Date.now() - startTime) / 1000);

        const choice = data?.choices?.[0]?.message;
        finalContent = choice?.content || "";
        if (choice?.reasoning_content) {
          reasoningContent = choice.reasoning_content;
        }

        hasToolCalls = choice?.tool_calls && choice.tool_calls.length > 0;
        if (hasToolCalls) {
          toolCallsToExecute = choice.tool_calls;
          loopMessages.push({
            role: "assistant",
            content: choice.content || null,
            tool_calls: choice.tool_calls
          } as any);
        }
      } else {
        // Gemini Provider
        const client = getGeminiClient(geminiKey);
        
        // Setup gemini compatible tools
        const geminiTools = [
          {
            functionDeclarations: activeToolsList.map(t => ({
              name: t.function.name,
              description: t.function.description,
              parameters: {
                type: "OBJECT",
                properties: t.function.parameters.properties,
                required: t.function.parameters.required
              }
            }))
          }
        ];

        // Format message tree to Gemini parts format
        const geminiContents: any[] = [];
        for (const msg of loopMessages) {
          if (msg.role === "system") continue;
          
          if (msg.parts && Array.isArray(msg.parts)) {
            geminiContents.push({
              role: msg.role === "assistant" ? "model" : "user",
              parts: msg.parts
            });
            continue;
          }
          
          const parts: any[] = [];
          let combinedText = msg.content || "";
          
          if (msg.files && Array.isArray(msg.files)) {
            for (const file of msg.files) {
              const match = file.base64.match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                const mimeType = match[1];
                const base64Data = match[2];
                
                if (file.parsedText && !file.parsedText.includes("двоичный формат, прямое распознавание текста не поддерживается")) {
                  combinedText = combinedText 
                    ? `${combinedText}\n\n${file.parsedText}`
                    : file.parsedText;
                } else {
                  // Direct inlineData support for images, pdfs, audios, video
                  const isMultimodalEligible = mimeType.startsWith("image/") || 
                                               mimeType === "application/pdf" || 
                                               mimeType.startsWith("audio/") || 
                                               mimeType.startsWith("video/");
                  if (isMultimodalEligible) {
                    parts.push({
                      inlineData: {
                        mimeType: mimeType,
                        data: base64Data
                      }
                    });
                  } else {
                    combinedText = combinedText 
                      ? `${combinedText}\n\n[Вложенный файл: ${file.name} (тип: ${mimeType}) - двоичный формат, содержимое скрыто]`
                      : `[Вложенный файл: ${file.name} (тип: ${mimeType}) - двоичный формат, содержимое скрыто]`;
                  }
                }
              }
            }
          }
          
          if (combinedText) {
            parts.push({ text: combinedText });
          }
          
          if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              parts.push({
                functionCall: {
                  name: tc.function.name,
                  args: typeof tc.function.arguments === "string" 
                    ? JSON.parse(tc.function.arguments) 
                    : tc.function.arguments
                }
              });
            }
          }
          
          if (msg.role === "tool") {
            parts.push({
              functionResponse: {
                name: msg.name,
                response: { result: msg.content }
              }
            });
          }

          geminiContents.push({
            role: msg.role === "assistant" ? "model" : "user",
            parts
          });
        }

        const configPayload: any = {
          systemInstruction: systemText,
          temperature: 0.6,
        };

        // Standard gemini supports function calling, use it
        if (!isReasoning) {
          configPayload.tools = geminiTools;
        }

        const response = await client.models.generateContent({
          model: activeModel,
          contents: geminiContents,
          config: configPayload
        });

        totalDuration += Math.round((Date.now() - startTime) / 1000);
        finalContent = response.text || "";

        const gCalls = response.functionCalls;
        hasToolCalls = gCalls && gCalls.length > 0;

        if (hasToolCalls) {
          // Map to standard tool call format
          const mappedCalls = gCalls.map((fc: any, idx: number) => ({
            id: `call-${Date.now()}-${idx}`,
            type: "function",
            function: {
              name: fc.name,
              arguments: JSON.stringify(fc.args)
            }
          }));

          toolCallsToExecute = mappedCalls;
          loopMessages.push({
            role: "assistant",
            content: finalContent || null,
            parts: response.candidates?.[0]?.content?.parts || [],
            tool_calls: mappedCalls
          } as any);
        }
      }

      if (!hasToolCalls) {
        completionNeeded = false;
        break;
      }

      // We have tool calls to execute!
      console.log(`Executing ${toolCallsToExecute.length} tool calls...`);

      for (const tc of toolCallsToExecute) {
        const toolName = tc.function.name;
        let args: any = {};
        try {
          args = typeof tc.function.arguments === "string" 
            ? JSON.parse(tc.function.arguments) 
            : tc.function.arguments;
        } catch (e) {
          console.error("Arg parsing error:", tc.function.arguments);
        }

        let output = "";
        let status: "success" | "error" = "success";

        try {
          if (toolName === "read_file") {
            output = await read_file_tool(args.path);
          } else if (toolName === "write_file") {
            output = await write_file_tool(args.path, args.content);
          } else if (toolName === "run_command") {
            output = await run_command_tool(args.command);
          } else if (toolName === "web_search") {
            output = await web_search_tool(args.query);
          } else if (toolName === "scrape_url") {
            output = await scrape_url_tool(args.url);
          } else if (toolName === "document_rag_search") {
            output = await document_rag_search_tool(args.path, args.query, routerKey, geminiKey);
          } else if (toolName === "delegate_task_to_model") {
            output = await delegate_task_to_model_tool(args.model, args.prompt, args.system_instruction, routerKey);
          } else if (toolName === "memorize_lesson") {
            const newItem = await add_lesson_record(args.category, args.title, args.details);
            output = `Новый урок "${newItem.title}" успешно сохранен в базу знаний самообучения VPS. Номер записи: ${newItem.id}`;
          } else {
            const customToolsList = await get_custom_tools();
            const matchedCustom = customToolsList.find((ct: any) => ct.name === toolName);
            if (matchedCustom) {
              output = await execute_custom_tool(matchedCustom, args);
            } else {
              output = `Инструмент ${toolName} не поддерживается.`;
              status = "error";
            }
          }
        } catch (execErr: any) {
          output = `Ошибка исполнения инструмента: ${execErr.message}`;
          status = "error";
        }

        toolCallsRecorded.push({
          toolName,
          arguments: args,
          output,
          status
        });

        // Add tool response to loopMessages
        loopMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: toolName,
          content: output
        } as any);
      }
    }

    // Record assistant's own response inside messages array for memory synchronization
    const finalHistoryForMemory = [
      ...activeMessages,
      { role: "assistant", content: finalContent }
    ];
    update_shared_memory(finalHistoryForMemory, routerKey, geminiKey).catch((e) =>
      console.error("[Memory Sync] Background update failed:", e)
    );

    return res.json({
      role: "assistant",
      content: finalContent,
      reasoningContent: reasoningContent || undefined,
      thinkingTime: reasoningContent || toolCallsRecorded.length > 0 ? totalDuration : undefined,
      provider: `${provider} API`,
      modelUsed: activeModel,
      toolCalls: toolCallsRecorded.length > 0 ? toolCallsRecorded : undefined
    });

  } catch (error: any) {
    console.error("Superagent Controller Error:", error);
    res.status(500).json({
      error: error.message || "Ошибка при выполнении запроса суперагента.",
    });
  }
});

/**
 * Voice Transcription Endpoint utilizing server-side Gemini 3.5 Flash
 */
app.post("/api/transcribe", async (req, res): Promise<any> => {
  try {
    const { audio, mimeType, geminiApiKey } = req.body;
    if (!audio) {
      return res.status(400).json({ error: "Предоставьте звуковые данные (base64) для транскрибирования." });
    }

    const key = geminiApiKey || req.headers["x-gemini-key"] || process.env.GEMINI_API_KEY;
    if (!key || key.trim() === "" || key.includes("MY_GEMINI_API_KEY")) {
      return res.status(400).json({
        error: "Для распознавания голосовых сообщений требуется настроенный GEMINI_API_KEY в Secrets/Свойствах проекта."
      });
    }

    console.log(`[Voice] Starting transcription... mimeType: ${mimeType || "audio/webm"}`);
    
    // Remove potential dataURL prefix
    let cleanBase64 = audio;
    if (audio.includes(";base64,")) {
      cleanBase64 = audio.split(";base64,")[1];
    }

    const ai = getGeminiClient(key);
    
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [
        {
          inlineData: {
            data: cleanBase64,
            mimeType: mimeType || "audio/webm"
          }
        },
        {
          text: "Транскрибируй это аудиосообщение на русском языке. Напиши только услышанный текст, без каких-либо комментариев, знаков препинания или собственных исправлений."
        }
      ]
    });

    const transcribedText = response.text || "";
    console.log(`[Voice] Transcribed Text: "${transcribedText.trim()}"`);
    return res.json({ text: transcribedText.trim() });
  } catch (err: any) {
    console.error("Transcription Controller Error:", err);
    return res.status(500).json({
      error: err.message || "Не удалось расшифровать голосовую запись."
    });
  }
});

/**
 * REST API for Session persistence across VPS server
 */
app.get("/api/sessions", async (req, res) => {
  try {
    const files = await fs.readdir(CONVERSATIONS_DIR);
    const sessions = [];
    for (const file of files) {
      if (file.endsWith(".json")) {
        try {
          const raw = await fs.readFile(path.join(CONVERSATIONS_DIR, file), "utf-8");
          sessions.push(JSON.parse(raw));
        } catch (e) {
          console.error(`Corrupt session file skipped: ${file}`);
        }
      }
    }
    // Sort chronologically (newest first)
    sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json(sessions);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to read sessions: " + err.message });
  }
});

app.post("/api/sessions", async (req, res) => {
  try {
    const session = req.body;
    if (!session || !session.id) {
      return res.status(400).json({ error: "Missing session body payload or session ID." });
    }
    const targetFile = path.join(CONVERSATIONS_DIR, `${session.id}.json`);
    await fs.writeFile(targetFile, JSON.stringify(session, null, 2), "utf-8");
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to save session: " + err.message });
  }
});

app.delete("/api/sessions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const targetFile = path.join(CONVERSATIONS_DIR, `${id}.json`);
    await fs.unlink(targetFile);
    res.json({ success: true });
  } catch (err: any) {
    // If file already deleted, ignore and succeed
    res.json({ success: true });
  }
});

/**
 * REST API for Lessons persistence (Agent self-learning experience DB)
 */
app.get("/api/lessons", async (req, res) => {
  try {
    const lessons = await get_lessons();
    res.json(lessons);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to read lessons: " + err.message });
  }
});

app.delete("/api/lessons/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const list = await get_lessons();
    const filtered = list.filter(l => l.id !== id);
    await fs.writeFile(LESSONS_FILE, JSON.stringify(filtered, null, 2), "utf-8");
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete lesson: " + err.message });
  }
});

// Setup Vite middleware in Development mode, otherwise serve build files in Production mode
const startServer = async () => {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
};

startServer().catch((err) => {
  console.error("Error starting server:", err);
});
