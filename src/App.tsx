import { useState, useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatWindow } from "./components/ChatWindow";
import { ChatSession, Message, LearnedLesson, ChatAttachment } from "./types";

const LOCAL_STORAGE_KEY = "deepseek_workspace_sessions_v1";
const ACTIVE_SESSION_KEY = "deepseek_workspace_active_id_v1";

export default function App() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lessons, setLessons] = useState<LearnedLesson[]>([]);
  const [deepseekApiKey, setDeepseekApiKey] = useState(() => localStorage.getItem("deepseek_apiKey") || "");
  const [geminiApiKey, setGeminiApiKey] = useState(() => localStorage.getItem("gemini_apiKey") || "");
  const [routerApiKey, setRouterApiKey] = useState(() => localStorage.getItem("router_apiKey") || "");

  const handleDeepseekApiKeyChange = (key: string) => {
    setDeepseekApiKey(key);
    localStorage.setItem("deepseek_apiKey", key);
  };

  const handleGeminiApiKeyChange = (key: string) => {
    setGeminiApiKey(key);
    localStorage.setItem("gemini_apiKey", key);
  };

  const handleRouterApiKeyChange = (key: string) => {
    setRouterApiKey(key);
    localStorage.setItem("router_apiKey", key);
  };

  // Keyboard shortcut listeners (Ctrl+I for new chat)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "i") {
        e.preventDefault();
        handleNewSession();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [sessions]);

  const fetchLessons = async () => {
    try {
      const res = await fetch("/api/lessons");
      if (res.ok) {
        const list = await res.json() as LearnedLesson[];
        setLessons(list);
      }
    } catch (e) {
      console.warn("Failed to load VPS lessons database:", e);
    }
  };

  const handleDeleteLesson = async (id: string) => {
    try {
      const res = await fetch(`/api/lessons/${id}`, { method: "DELETE" });
      if (res.ok) {
        setLessons(prev => prev.filter(l => l.id !== id));
      }
    } catch (e) {
      console.error("Failed to delete lesson node:", e);
    }
  };

  // Sync and restore logs on initial mount
  useEffect(() => {
    const syncWithVPS = async () => {
      fetchLessons();
      try {
        const storedActive = localStorage.getItem(ACTIVE_SESSION_KEY);
        const res = await fetch("/api/sessions");
        if (res.ok) {
          const serverSessions = await res.json() as ChatSession[];
          if (serverSessions && serverSessions.length > 0) {
            setSessions(serverSessions);
            localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(serverSessions));
            
            if (storedActive && serverSessions.some((s) => s.id === storedActive)) {
              setActiveSessionId(storedActive);
            } else {
              setActiveSessionId(serverSessions[0].id);
            }
            return;
          }
        }
      } catch (err) {
        console.warn("Could not sync with VPS directory server storage on initial mount:", err);
      }

      // fallback local storage
      try {
        const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
        const storedActive = localStorage.getItem(ACTIVE_SESSION_KEY);

        if (stored) {
          const parsed = JSON.parse(stored) as ChatSession[];
          setSessions(parsed);
          if (storedActive && parsed.some((s) => s.id === storedActive)) {
            setActiveSessionId(storedActive);
          } else if (parsed.length > 0) {
            setActiveSessionId(parsed[0].id);
          }
        } else {
          const defaultSession: ChatSession = {
            id: "default-seek-session",
            title: "Новый диалог",
            messages: [],
            deepThink: true,
            webSearch: false,
            createdAt: new Date().toISOString(),
            model: "auto",
          };
          setSessions([defaultSession]);
          setActiveSessionId(defaultSession.id);
          localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify([defaultSession]));
          localStorage.setItem(ACTIVE_SESSION_KEY, defaultSession.id);
        }
      } catch (err) {
        console.error("Local restoration config error:", err);
      }
    };

    syncWithVPS();
  }, []);

  // Utility persistence function mapping to local storage & async VPS sync
  const saveSessions = async (newSessions: ChatSession[], updatedSessionId?: string) => {
    setSessions(newSessions);
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(newSessions));

    if (updatedSessionId) {
      const target = newSessions.find((s) => s.id === updatedSessionId);
      if (target) {
        try {
          await fetch("/api/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(target),
          });
        } catch (e) {
          console.warn("Could not sync modified session to VPS:", e);
        }
      }
    }
  };

  const getActiveSession = (): ChatSession | null => {
    if (!activeSessionId) return null;
    return sessions.find((s) => s.id === activeSessionId) || null;
  };

  const activeSession = getActiveSession();

  // Create new session
  const handleNewSession = async () => {
    const newId = `session-${Date.now()}`;
    const newSession: ChatSession = {
      id: newId,
      title: "Новый диалог",
      messages: [],
      deepThink: true,
      webSearch: false,
      createdAt: new Date().toISOString(),
      model: "auto",
    };

    const updated = [newSession, ...sessions];
    await saveSessions(updated, newId);
    setActiveSessionId(newId);
    localStorage.setItem(ACTIVE_SESSION_KEY, newId);
    setErrorMsg(null);
  };

  // Delete session
  const handleDeleteSession = async (id: string) => {
    const updated = sessions.filter((s) => s.id !== id);
    setSessions(updated);
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(updated));

    try {
      await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    } catch (e) {
      console.warn("Could not delete session from VPS storage:", e);
    }

    if (activeSessionId === id) {
      if (updated.length > 0) {
        setActiveSessionId(updated[0].id);
        localStorage.setItem(ACTIVE_SESSION_KEY, updated[0].id);
      } else {
        const fallbackId = `session-${Date.now()}`;
        const fallbackSession: ChatSession = {
          id: fallbackId,
          title: "Новый диалог",
          messages: [],
          deepThink: true,
          webSearch: false,
          createdAt: new Date().toISOString(),
          model: "auto",
        };
        await saveSessions([fallbackSession], fallbackId);
        setActiveSessionId(fallbackId);
        localStorage.setItem(ACTIVE_SESSION_KEY, fallbackId);
      }
    }
    setErrorMsg(null);
  };

  // Select dialogue
  const handleSelectSession = (id: string) => {
    setActiveSessionId(id);
    localStorage.setItem(ACTIVE_SESSION_KEY, id);
    setErrorMsg(null);
  };

  // Toggle DeepThink parameter per session
  const handleToggleDeepThink = async () => {
    if (!activeSessionId) return;
    const updated = sessions.map((s) => {
      if (s.id === activeSessionId) {
        return { ...s, deepThink: !s.deepThink };
      }
      return s;
    });
    await saveSessions(updated, activeSessionId);
  };

  // Toggle WebSearch parameter per session
  const handleToggleWebSearch = async () => {
    if (!activeSessionId) return;
    const updated = sessions.map((s) => {
      if (s.id === activeSessionId) {
        return { ...s, webSearch: !s.webSearch };
      }
      return s;
    });
    await saveSessions(updated, activeSessionId);
  };

  // Change model per session
  const handleChangeModel = async (model: string) => {
    if (!activeSessionId) return;
    const updated = sessions.map((s) => {
      if (s.id === activeSessionId) {
        return { ...s, model };
      }
      return s;
    });
    await saveSessions(updated, activeSessionId);
  };

  // Erase existing logs
  const handleClearSession = async () => {
    if (!activeSessionId) return;
    const updated = sessions.map((s) => {
      if (s.id === activeSessionId) {
        return {
          ...s,
          title: "Новый диалог",
          messages: [],
        };
      }
      return s;
    });
    await saveSessions(updated, activeSessionId);
    setErrorMsg(null);
  };

  // Dispatch standard text prompts or voice messages
  const handleSendMessage = async (content: string, audioUrl?: string, files?: ChatAttachment[]) => {
    if (!activeSessionId || isLoading) return;

    const currentSession = sessions.find((s) => s.id === activeSessionId);
    if (!currentSession) return;

    // Build user message JSON
    const userMessage: Message = {
      id: `msg-${Date.now()}`,
      role: "user",
      content: content,
      timestamp: new Date().toISOString(),
      audioUrl: audioUrl,
      files: files,
    };

    const newMessages = [...currentSession.messages, userMessage];

    // Auto update chat title from prompt content
    let newTitle = currentSession.title;
    if (currentSession.title === "Новый диалог") {
      newTitle = content.length > 25 ? `${content.slice(0, 25).trim()}...` : content;
    }

    const updatedSessions = sessions.map((s) => {
      if (s.id === activeSessionId) {
        return {
          ...s,
          title: newTitle,
          messages: newMessages,
        };
      }
      return s;
    });

    await saveSessions(updatedSessions, activeSessionId);
    setIsLoading(true);
    setErrorMsg(null);

    try {
      // Map frontend logs to simple context parameter including files and tool execution history
      const contextLogs = newMessages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        files: m.files,
        toolCalls: m.toolCalls,
      }));

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: contextLogs,
          deepThink: currentSession.deepThink,
          webSearch: currentSession.webSearch,
          model: currentSession.model || "auto",
          deepseekApiKey,
          geminiApiKey,
          routerApiKey,
        }),
      });

      if (!res.ok) {
        let errMsg = "Ошибка при генерации ответа моделью DeepSeek.";
        try {
          const errText = await res.text();
          try {
            const errData = JSON.parse(errText);
            errMsg = errData.error || errMsg;
          } catch {
            if (errText && errText.trim()) {
              errMsg = errText;
            }
          }
        } catch (readErr: any) {
          errMsg = `Ошибка чтения ответа: ${readErr.message}`;
        }
        throw new Error(errMsg);
      }

      let data: any;
      try {
        const resText = await res.text();
        data = JSON.parse(resText);
      } catch (jsonErr: any) {
        throw new Error("Внутренняя ошибка сервера или превышено время ожидания. Не удалось обработать JSON.");
      }

      // Build model message JSON
      const assistantMessage: Message = {
        id: `msg-${Date.now() + 1}`,
        role: "assistant",
        content: data.content,
        timestamp: new Date().toISOString(),
        reasoningContent: data.reasoningContent,
        thinkingTime: data.thinkingTime,
        toolCalls: data.toolCalls,
      };

      const finalSessions = updatedSessions.map((s) => {
        if (s.id === activeSessionId) {
          return {
            ...s,
            messages: [...s.messages, assistantMessage],
          };
        }
        return s;
      });

      await saveSessions(finalSessions, activeSessionId);
      fetchLessons();
    } catch (err: any) {
      console.error("Connection calling proxy failed:", err);
      setErrorMsg(err.message || "Ошибка связи с сервером. Пожалуйста, перезапустите.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex w-full h-screen overflow-hidden bg-white text-zinc-900 font-sans">
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        onDeleteSession={handleDeleteSession}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        lessons={lessons}
        onDeleteLesson={handleDeleteLesson}
        deepseekApiKey={deepseekApiKey}
        onDeepseekApiKeyChange={handleDeepseekApiKeyChange}
        geminiApiKey={geminiApiKey}
        onGeminiApiKeyChange={handleGeminiApiKeyChange}
        routerApiKey={routerApiKey}
        onRouterApiKeyChange={handleRouterApiKeyChange}
      />

      <ChatWindow
        session={activeSession}
        onSendMessage={handleSendMessage}
        onClearSession={handleClearSession}
        isLoading={isLoading}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        errorMsg={errorMsg}
        onToggleDeepThink={handleToggleDeepThink}
        onToggleWebSearch={handleToggleWebSearch}
        onChangeModel={handleChangeModel}
        geminiApiKey={geminiApiKey}
      />
    </div>
  );
}
