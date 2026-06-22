import React, { useRef, useEffect, useState } from "react";
import {
  Send,
  Trash2,
  Menu,
  Globe,
  Sparkles,
  RefreshCw,
  AlertCircle,
  Brain,
  ChevronDown,
  ChevronUp,
  Database,
  CloudLightning,
  Mic,
  Square,
  Play,
  Pause,
  Paperclip,
  FileText,
  X,
  Image as ImageIcon
} from "lucide-react";
import { ChatSession, Message, ChatAttachment } from "../types";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ChatInput, ChatInputRef } from "./ChatInput";

interface ChatWindowProps {
  session: ChatSession | null;
  onSendMessage: (content: string, audioUrl?: string, files?: ChatAttachment[]) => void;
  onClearSession: () => void;
  isLoading: boolean;
  onToggleSidebar: () => void;
  errorMsg: string | null;
  onToggleDeepThink: () => void;
  onToggleWebSearch: () => void;
  onChangeModel: (model: string) => void;
  geminiApiKey: string;
}

const VoiceMessagePlayer: React.FC<{ audioUrl: string }> = ({ audioUrl }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
    };

    const onLoadedMetadata = () => {
      setDuration(audio.duration || 0);
    };

    const onEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("ended", onEnded);

    // Some browsers won't fire loadedmetadata unless audited. Trigger pre-auditing
    if (audio.readyState >= 2) {
      setDuration(audio.duration || 0);
    }

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("ended", onEnded);
    };
  }, [audioUrl]);

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play().catch((e) => console.warn("Playback prevented:", e));
      setIsPlaying(true);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const val = parseFloat(e.target.value);
    audio.currentTime = val;
    setCurrentTime(val);
  };

  const formatTime = (secs: number) => {
    if (isNaN(secs)) return "0:00";
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  return (
    <div className="flex items-center gap-3 bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 max-w-[280px] select-none my-1">
      <audio ref={audioRef} src={audioUrl} preload="metadata" />
      <button
        type="button"
        onClick={togglePlayback}
        className="w-8 h-8 rounded-full bg-[#1b5df7] text-white flex items-center justify-center hover:bg-blue-600 transition-colors cursor-pointer shrink-0"
      >
        {isPlaying ? (
          <Pause size={13} fill="currentColor" />
        ) : (
          <Play size={13} className="ml-0.5" fill="currentColor" />
        )}
      </button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center">
          <input
            type="range"
            min={0}
            max={duration || 100}
            value={currentTime}
            onChange={handleSeek}
            className="w-full accent-[#1b5df7] h-1 bg-zinc-200 rounded-lg appearance-none cursor-pointer"
          />
        </div>
        <div className="flex justify-between text-[9px] text-zinc-400 font-mono mt-1 select-none">
          <span>{formatTime(currentTime)}</span>
          <span>{duration ? formatTime(duration) : "0:00"}</span>
        </div>
      </div>
    </div>
  );
};

export const ChatWindow: React.FC<ChatWindowProps> = ({
  session,
  onSendMessage,
  onClearSession,
  isLoading,
  onToggleSidebar,
  errorMsg,
  onToggleDeepThink,
  onToggleWebSearch,
  onChangeModel,
  geminiApiKey,
}) => {
  const chatInputRef = useRef<ChatInputRef | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Thinking toggles UI expanded states
  const [expandedThoughts, setExpandedThoughts] = useState<Record<string, boolean>>({});

  // Auto-scroll to bottom of conversation
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [session?.messages?.length, isLoading]);

  const toggleThoughtVisibility = (messageId: string) => {
    setExpandedThoughts((prev) => ({
      ...prev,
      [messageId]: !prev[messageId],
    }));
  };

  if (!session) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-white p-6 text-center select-none">
        <Sparkles size={40} className="text-[#1b5df7]/25 mb-3 animate-pulse" />
        <h3 className="text-base font-semibold text-zinc-950 font-sans">Нет активной сессии</h3>
        <p className="text-xs text-zinc-500 mt-2 max-w-xs font-sans">
          Нажмите кнопку «Новый чат» в боковой панели, чтобы начать диалог DeepSeek.
        </p>
      </div>
    );
  }

  const { messages, deepThink, webSearch } = session;

  return (
    <div className="flex-1 flex flex-col h-full bg-white relative">
      {/* Viewport Header */}
      <header className="h-14 border-b border-[#e8ecf1] flex items-center justify-between px-4 bg-white shrink-0 z-20">
        <div className="flex items-center gap-3">
          <button
            onClick={onToggleSidebar}
            className="lg:hidden p-2 -ml-2 rounded-lg text-zinc-500 hover:bg-zinc-150 hover:text-zinc-900 cursor-pointer"
          >
            <Menu size={18} />
          </button>
          <div>
            <h2 className="text-xs sm:text-sm font-semibold text-zinc-900 line-clamp-1 max-w-[200px] sm:max-w-xs font-sans">
              {session.title || "Новый диалог"}
            </h2>
          </div>
        </div>

        {/* Global Toolbar and connection indicators */}
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            <span className="hidden sm:inline text-[11px] text-zinc-500 font-medium font-sans">Модель:</span>
            
            {/* Custom Manual model ID Input if requested */}
            {(() => {
              const predefinedModels = [
                "auto",
                "deepseek-chat",
                "deepseek-reasoning",
                "gemini-3.5-flash",
                "google/gemini-2.5-flash",
                "google/gemini-2.5-pro",
                "anthropic/claude-3-5-sonnet",
                "openai/gpt-4o",
                "openai/gpt-4o-mini",
                "qwen/qwen-2.5-72b-instruct"
              ];
              const currentModel = session.model || "auto";
              const isCustom = !predefinedModels.includes(currentModel);
              
              return (
                <>
                  <select
                    value={isCustom ? "custom_input_flag" : currentModel}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === "custom_input_flag") {
                        onChangeModel("deepseek/deepseek-r1");
                      } else {
                        onChangeModel(val);
                      }
                    }}
                    disabled={isLoading}
                    className="text-xs font-semibold text-zinc-700 bg-zinc-50 hover:bg-zinc-100 border border-zinc-200 focus:border-[#1b5df7] rounded-lg px-2 py-1 focus:outline-hidden transition-colors cursor-pointer font-sans"
                  >
                    <option value="auto">🤖 Авто (выбор)</option>
                    <option value="deepseek-chat">⚡ DeepSeek V3 (Chat)</option>
                    <option value="deepseek-reasoning">🧠 DeepSeek R1 (DeepThink)</option>
                    <option value="gemini-3.5-flash">✨ Gemini 3.5 Flash</option>
                    <option value="google/gemini-2.5-flash">✨ Gemini 2.5 Flash</option>
                    <option value="google/gemini-2.5-pro">💎 Gemini 2.5 Pro</option>
                    <option value="anthropic/claude-3-5-sonnet">🦉 Claude 3.5 Sonnet</option>
                    <option value="openai/gpt-4o">🚀 GPT-4o</option>
                    <option value="openai/gpt-4o-mini">⚡ GPT-4o Mini</option>
                    <option value="qwen/qwen-2.5-72b-instruct">🇨🇳 Qwen 2.5-72B</option>
                    <option value="custom_input_flag">✏️ Ввести ID вручную...</option>
                  </select>
                  
                  {isCustom && (
                    <input
                      type="text"
                      placeholder="id модели (например: deepseek/deepseek-r1)"
                      value={currentModel}
                      onChange={(e) => onChangeModel(e.target.value)}
                      disabled={isLoading}
                      className="text-[11px] font-semibold text-zinc-600 bg-zinc-50 border border-zinc-200 focus:border-[#1b5df7] rounded-lg px-2 py-1 focus:outline-hidden font-mono w-40 sm:w-52 transition-all"
                      title="Введите точный ID любой модели из RouterAI (доступно более 300 моделей)"
                    />
                  )}
                </>
              );
            })()}
          </div>

          {messages.length > 0 && (
            <button
              onClick={onClearSession}
              title="Очистить диалог"
              className="p-1.5 rounded-lg text-zinc-400 hover:text-rose-600 hover:bg-rose-50 border border-transparent hover:border-rose-100 transition-colors cursor-pointer"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </header>

      {/* Message Stream */}
      <div className="flex-1 overflow-y-auto bg-white scrollbar-thin flex flex-col">
        {messages.length === 0 ? (
          /* Empty Chat Welcome Page - Exactly mimicking DeepSeek style */
          <div className="flex-1 flex flex-col justify-center items-center px-4 max-w-xl mx-auto w-full select-none text-center">
            {/* Round DeepSeek icon */}
            <div className="w-14 h-14 rounded-full bg-[#1b5df7] flex items-center justify-center text-white mb-6 animate-scale shadow-xs">
              <Brain size={28} className="text-white shrink-0" />
            </div>
            <h3 className="text-xl font-bold text-zinc-950 tracking-tight font-sans">
              Как я могу помочь вам сегодня?
            </h3>
            <p className="text-xs sm:text-sm text-zinc-500 mt-2.5 max-w-md leading-relaxed font-sans">
              Я высокотехнологичный <span className="text-[#1b5df7] font-semibold">Суперагент Ин-Кон</span>. Включите <span className="font-semibold text-purple-600">DeepThink (R1)</span> для глубоких рассуждений. Или отключите его, чтобы активировать <span className="text-emerald-700 font-semibold">Режим Суперагента (V3)</span>, способного управлять файлами, искать в сети и выполнять bash-команды на вашем VPS сервере!
            </p>

            {/* Quick tips */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-8 w-full font-sans">
              <button
                onClick={() => chatInputRef.current?.setValue("Покажи файлы в текущей директории и свободное место на диске (df -h)")}
                className="p-3 bg-zinc-50 hover:bg-zinc-100 hover:border-emerald-500/30 text-left border border-zinc-200 rounded-xl transition-all cursor-pointer text-xs"
              >
                <div className="font-semibold text-zinc-900">📟 Выполнение команд на VPS</div>
                <div className="text-zinc-500 mt-0.5 line-clamp-1 text-[11px]">Посмотреть файлы и статус диска сервера</div>
              </button>
              <button
                onClick={() => chatInputRef.current?.setValue("Создай текстовый файл test_agent.txt со стихом Пушкина, а потом прочитай его содержимое")}
                className="p-3 bg-zinc-50 hover:bg-zinc-100 hover:border-emerald-500/30 text-left border border-zinc-200 rounded-xl transition-all cursor-pointer text-xs"
              >
                <div className="font-semibold text-zinc-900">📂 Управление файлами</div>
                <div className="text-zinc-500 mt-0.5 line-clamp-1 text-[11px]">Автоматическое создание и чтение файлов</div>
              </button>
            </div>
          </div>
        ) : (
          /* Message items list */
          <div className="flex-1 max-w-3xl w-full mx-auto px-4 py-6 sm:py-8 space-y-8 select-text font-sans">
            {messages.map((msg) => {
              const isUser = msg.role === "user";
              const thoughtExpanded = expandedThoughts[msg.id] !== false; // defaults to true

              return (
                <div key={msg.id} className="flex gap-4 items-start animate-fade">
                  {/* Left avatar placeholder */}
                  <div
                    className={`w-7 sm:w-8 h-7 sm:h-8 rounded-full shrink-0 flex items-center justify-center select-none text-xs ${
                      isUser
                        ? "bg-zinc-200 text-zinc-700 border border-zinc-300"
                        : "bg-[#1b5df7] text-white"
                    }`}
                  >
                    {isUser ? "Вы" : <Brain size={14} className="text-white shrink-0" />}
                  </div>

                  {/* Message content block */}
                  <div className="min-w-0 flex-1 space-y-3.5 leading-relaxed font-sans text-[15px]">
                    {/* Header bar */}
                    <div className="flex items-center gap-2">
                       <span className="text-xs font-semibold text-zinc-900">
                        {isUser ? "Вы" : "Ин-Кон"}
                      </span>
                      <span className="text-[10px] text-zinc-400 font-mono">
                        {new Date(msg.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>

                    {/* DeepSeek R1 Thinking visual block */}
                    {!isUser && msg.reasoningContent && (
                      <div className="border-l-2 border-[#1b5df7]/20 pl-3 py-0.5 space-y-2">
                        <button
                          onClick={() => toggleThoughtVisibility(msg.id)}
                          className="flex items-center gap-1.5 text-xs font-semibold text-zinc-500 hover:text-[#1b5df7] transition-all cursor-pointer select-none"
                        >
                          <Brain size={13} className="text-zinc-500" />
                          <span>
                            {thoughtExpanded ? "Свернуть рассуждения" : "Показать рассуждения"}
                          </span>
                          {msg.thinkingTime && (
                            <span className="text-[11px] font-mono bg-zinc-100 text-zinc-600 rounded-md px-1.5 py-0.2 ml-1">
                              Размышление: {msg.thinkingTime} сек
                            </span>
                          )}
                          {thoughtExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                        </button>

                        {thoughtExpanded && (
                          <div className="text-xs sm:text-[13px] text-zinc-500 italic leading-relaxed font-sans bg-zinc-50 rounded-lg p-3 border border-zinc-150 select-text whitespace-pre-wrap max-h-96 overflow-y-auto scrollbar-thin">
                            {msg.reasoningContent}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Superagent executed tool calls log */}
                    {!isUser && msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div className="space-y-2 py-1 select-none">
                        {msg.toolCalls.map((tc, idx) => {
                          const isOk = tc.status === "success";
                          return (
                            <div key={idx} className="border border-zinc-200 rounded-lg bg-zinc-50/50 overflow-hidden text-xs max-w-full font-sans">
                              <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-100/80 border-b border-zinc-200">
                                <div className="flex items-center gap-1.5 font-semibold text-zinc-700">
                                  <span className={`w-2 h-2 rounded-full ${isOk ? "bg-emerald-500" : "bg-rose-500"}`}></span>
                                  <span>Вызов: <code className="bg-zinc-200 px-1 py-0.5 rounded text-[10px] font-mono text-zinc-950">{tc.toolName}</code></span>
                                </div>
                                <span className={`text-[9.5px] font-semibold px-2 py-0.5 rounded-full ${isOk ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                                  {isOk ? "Успешно" : "Ошибка"}
                                </span>
                              </div>
                              <div className="p-2 space-y-1 bg-white">
                                <div className="text-[10.5px] text-zinc-500">
                                  <span className="font-semibold text-zinc-600">Параметры: </span>
                                  <code className="font-mono text-zinc-700 break-all">{JSON.stringify(tc.arguments)}</code>
                                </div>
                                <details className="cursor-pointer">
                                  <summary className="text-[10px] text-[#1b5df7] font-semibold hover:underline outline-hidden">
                                    Показать консольный вывод ({tc.output?.length || 0} симв.)
                                  </summary>
                                  <div className="mt-1 p-2 bg-zinc-950 text-zinc-200 rounded-md font-mono text-[10px] whitespace-pre-wrap overflow-x-auto max-h-48 scrollbar-thin leading-snug">
                                    {tc.output || "[Пустой вывод]"}
                                  </div>
                                </details>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Main content block */}
                    <div className="text-zinc-900 text-sm sm:text-base leading-relaxed break-words select-text pt-0.5">
                      {isUser ? (
                        <div className="space-y-2.5">
                          {msg.audioUrl && (
                            <VoiceMessagePlayer audioUrl={msg.audioUrl} />
                          )}
                          <p className="whitespace-pre-wrap font-sans text-[15px]">{msg.content}</p>
                          
                          {/* Attached files preview list */}
                          {msg.files && msg.files.length > 0 && (
                            <div className="flex flex-wrap gap-2 mt-2 select-none">
                              {msg.files.map((file, fIdx) => {
                                const isImg = file.type.startsWith("image/");
                                return (
                                  <div key={fIdx} className="flex items-center gap-2.5 p-2 bg-zinc-50 border border-zinc-200 rounded-xl max-w-[240px] shadow-3xs text-xs animate-fade">
                                    {isImg ? (
                                      <a href={file.base64} target="_blank" rel="noopener noreferrer" className="block shrink-0 cursor-zoom-in">
                                        <img
                                          src={file.base64}
                                          alt={file.name}
                                          className="w-10 h-10 rounded-lg object-cover bg-zinc-100 border border-zinc-150 hover:opacity-95 transition-opacity"
                                          referrerPolicy="no-referrer"
                                        />
                                      </a>
                                    ) : (
                                      <div className="w-10 h-10 rounded-lg bg-blue-50 border border-blue-150 flex items-center justify-center text-[#1b5df7] shrink-0 font-sans">
                                        <FileText size={18} />
                                      </div>
                                    )}
                                    <div className="min-w-0 flex-1 font-sans">
                                      <div className="font-semibold text-zinc-900 truncate leading-snug" title={file.name}>
                                        {file.name}
                                      </div>
                                      <div className="text-[10px] text-zinc-400 font-mono mt-0.5">
                                        {file.size ? `${(file.size / 1024).toFixed(1)} КБ` : "файл"}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ) : (
                        <MarkdownRenderer content={msg.content} />
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* AI active generation state */}
            {isLoading && (
              <div className="flex gap-4 items-start animate-fade pt-2">
                <div className="w-7 sm:w-8 h-7 sm:h-8 rounded-full bg-[#1b5df7] shrink-0 flex items-center justify-center text-white">
                  <Brain size={14} className="text-white shrink-0 animate-scale" />
                </div>
                <div className="min-w-0 flex-1 space-y-3 font-sans">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-zinc-900">Ин-Кон</span>
                    <span className="text-[10px] text-zinc-400 animate-pulse font-medium">Думает...</span>
                  </div>

                  {/* Pulsing loading effect */}
                  {deepThink ? (
                    <div className="border-l-2 border-[#1b5df7] bg-blue-50/20 p-2.5 rounded-r-lg inline-flex items-center gap-2 text-xs font-medium text-blue-600 animate-pulse select-none font-sans">
                      <Brain size={14} className="animate-spin text-[#1b5df7]" />
                      <span>Анализ мыслительного процесса (R1)...</span>
                    </div>
                  ) : (
                    <div className="border-l-2 border-emerald-500 bg-emerald-50/30 p-2.5 rounded-r-lg inline-flex items-center gap-2 text-xs font-medium text-emerald-700 animate-pulse select-none font-sans">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>
                      <span>Суперагент Ин-Кон: выполнение системных инструментов (VPS)...</span>
                    </div>
                  )}

                  <div className="space-y-2 max-w-md animate-pulse pt-1">
                    <div className="h-3 bg-zinc-150 rounded w-full"></div>
                    <div className="h-3 bg-zinc-150 rounded w-5/6"></div>
                    <div className="h-3 bg-zinc-150 rounded w-2/3"></div>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Errors Prompts */}
      {errorMsg && (
        <div className="bg-rose-50 border-t border-rose-200 px-4 py-2.5 shrink-0 animate-fade">
          <div className="max-w-2xl mx-auto flex gap-2 items-start text-xs text-rose-800">
            <AlertCircle className="text-rose-600 shrink-0 mt-0.5 font-bold" size={15} />
            <div className="min-w-0 flex-1 font-sans">
              <p className="font-semibold text-rose-950">Приостановлено</p>
              <p className="mt-0.5 font-medium leading-relaxed text-rose-900">
                {errorMsg}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Isolated Chat Input Micro-component */}
      <ChatInput
        ref={chatInputRef}
        onSendMessage={onSendMessage}
        isLoading={isLoading}
        deepThink={deepThink}
        webSearch={webSearch}
        onToggleDeepThink={onToggleDeepThink}
        onToggleWebSearch={onToggleWebSearch}
        geminiApiKey={geminiApiKey}
      />
    </div>
  );
};
