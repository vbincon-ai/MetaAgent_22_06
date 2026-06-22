import React, { useRef, useEffect, useState, forwardRef, useImperativeHandle } from "react";
import {
  Send,
  Trash2,
  Globe,
  RefreshCw,
  Brain,
  Paperclip,
  FileText,
  X,
  Mic,
  Square
} from "lucide-react";
import { ChatAttachment } from "../types";

export interface ChatInputRef {
  setValue: (value: string) => void;
}

interface ChatInputProps {
  onSendMessage: (content: string, audioUrl?: string, files?: ChatAttachment[]) => void;
  isLoading: boolean;
  deepThink: boolean;
  webSearch: boolean;
  onToggleDeepThink: () => void;
  onToggleWebSearch: () => void;
  geminiApiKey: string;
}

export const ChatInput = forwardRef<ChatInputRef, ChatInputProps>(({
  onSendMessage,
  isLoading,
  deepThink,
  webSearch,
  onToggleDeepThink,
  onToggleWebSearch,
  geminiApiKey,
}, ref) => {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Expose setValue to parent using forwardRef + useImperativeHandle
  useImperativeHandle(ref, () => ({
    setValue: (value: string) => {
      setInput(value);
      // Focus textarea and adjust height
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    }
  }));

  // File/image attachment states
  const [selectedFiles, setSelectedFiles] = useState<ChatAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const filesArray = Array.from(e.target.files);
    processFiles(filesArray);
  };

  const processFiles = (files: File[]) => {
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result as string;
        const newAttachment: ChatAttachment = {
          name: file.name,
          type: file.type || "application/octet-stream",
          base64: base64,
          size: file.size
        };
        setSelectedFiles((prev) => [...prev, newAttachment]);
      };
      reader.readAsDataURL(file);
    });
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const filesArray = Array.from(e.dataTransfer.files);
      processFiles(filesArray);
    }
  };

  const handleRemoveFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // Voice recording states
  const [isRecording, setIsRecording] = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  // Recording Timer
  useEffect(() => {
    let interval: any = null;
    if (isRecording) {
      interval = setInterval(() => {
        setRecordDuration((prev) => prev + 1);
      }, 1000);
    } else {
      setRecordDuration(0);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isRecording]);

  const formatDuration = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  const startRecording = async () => {
    setVoiceError(null);
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Ваш браузер или платформа не поддерживает воспроизведение или запись аудио.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunks.push(e.data);
        }
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());

        const audioBlob = new Blob(chunks, { type: "audio/webm" });
        if (audioBlob.size < 500) {
          return;
        }

        setIsTranscribing(true);
        try {
          const reader = new FileReader();
          reader.readAsDataURL(audioBlob);
          reader.onloadend = async () => {
            const base64data = reader.result as string;

            const response = await fetch("/api/transcribe", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                audio: base64data,
                mimeType: "audio/webm",
                geminiApiKey,
              }),
            });

            if (!response.ok) {
              const errInfo = await response.json();
              throw new Error(errInfo.error || "Ошибка расшифровки аудио.");
            }

            const data = await response.json();
            const text = data.text || "";

            if (!text.trim()) {
              setVoiceError("Голос не распознан. Пожалуйста, повторите фразу более четко.");
            } else {
              onSendMessage(text.trim(), base64data);
            }
          };
        } catch (err: any) {
          console.error("Transcription client error:", err);
          setVoiceError(err.message || "Ошибка распознавания голоса.");
        } finally {
          setIsTranscribing(false);
        }
      };

      recorder.start();
      setMediaRecorder(recorder);
      setIsRecording(true);
    } catch (err: any) {
      console.error("Microphone capture failed:", err);
      setVoiceError(
        "Не удалось получить доступ к микрофону. Разрешите права на запись во фрейме/браузере и убедитесь, что GEMINI_API_KEY добавлен в настройки Secrets."
      );
    }
  };

  const stopRecording = () => {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    setIsRecording(false);
  };

  const cancelRecording = () => {
    if (mediaRecorder) {
      mediaRecorder.onstop = () => {
        mediaRecorder.stream.getTracks().forEach((track) => track.stop());
      };
      if (mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
    }
    setIsRecording(false);
    setRecordDuration(0);
  };

  // Handle textarea height auto-adjust
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      const minHeight = 72; // Default to about 3 lines
      const newHeight = Math.max(textareaRef.current.scrollHeight, minHeight);
      textareaRef.current.style.height = `${Math.min(newHeight, 180)}px`;
    }
  }, [input]);

  const handleSendText = () => {
    if ((!input.trim() && selectedFiles.length === 0) || isLoading) return;
    onSendMessage(input.trim(), undefined, selectedFiles);
    setInput("");
    setSelectedFiles([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendText();
    }
  };

  return (
    <footer className="border-t border-[#e8ecf1] p-3 sm:p-4 bg-white z-20 shrink-0 select-none">
      <div className="max-w-3xl mx-auto">
        {/* Voice status error warning if any */}
        {voiceError && (
          <div className="mb-2.5 p-2 py-2.5 px-3.5 bg-amber-50 text-amber-800 border border-amber-200 rounded-xl text-xs flex justify-between items-center animate-fade font-sans shrink-0 max-w-full">
            <span className="font-semibold text-left leading-relaxed">{voiceError}</span>
            <button
              type="button"
              onClick={() => setVoiceError(null)}
              className="text-[10px] text-amber-500 hover:text-amber-800 font-bold ml-3 cursor-pointer shrink-0"
            >
              Закрыть
            </button>
          </div>
        )}

        {/* Standard DeepSeek Styled Input Area */}
        <div 
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className="border border-[#d0d7de] rounded-2xl bg-[#fafafa] focus-within:bg-white focus-within:border-[#1b5df7] transition-all shadow-xs pr-2 py-1.5 relative flex flex-col select-none"
        >
          {/* Drag & Drop Visual Overlay Feed */}
          {isDragging && (
            <div className="absolute inset-0 bg-blue-500/10 border-2 border-dashed border-[#1b5df7] rounded-2xl flex items-center justify-center z-50 pointer-events-none animate-fade">
              <div className="bg-white px-4 py-3 rounded-2xl shadow-lg border border-blue-200 flex items-center gap-2 text-sm font-semibold text-[#1b5df7] font-sans">
                <Paperclip size={16} className="animate-bounce" />
                <span>Перетащите файлы сюда, чтобы прикрепить</span>
              </div>
            </div>
          )}

          {isRecording ? (
            /* Active microphone recording status */
            <div className="flex-1 flex items-center justify-between px-3.5 py-2 rounded-xl animate-fade">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="relative flex h-2.5 w-2.5 select-none shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-rose-600"></span>
                </span>
                <span className="text-xs sm:text-sm font-semibold text-rose-700 font-mono select-none">
                  Запись голосового: {formatDuration(recordDuration)}
                </span>
                
                {/* SOUNDWAVE BOUNCING EFFECT */}
                <div className="flex items-end gap-0.5 h-3 select-none pl-1 shrink-0">
                  <div className="w-0.5 bg-rose-600 rounded-full animate-bounce h-1.5" style={{ animationDuration: "0.6s" }}></div>
                  <div className="w-0.5 bg-rose-600 rounded-full animate-bounce h-3" style={{ animationDuration: "0.4s", animationDelay: "0.15s" }}></div>
                  <div className="w-0.5 bg-rose-600 rounded-full animate-bounce h-2" style={{ animationDuration: "0.5s", animationDelay: "0.07s" }}></div>
                  <div className="w-0.5 bg-rose-600 rounded-full animate-bounce h-1" style={{ animationDuration: "0.3s", animationDelay: "0.2s" }}></div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={cancelRecording}
                  className="p-1.5 text-zinc-450 hover:bg-zinc-150 hover:text-zinc-800 rounded-full transition-all cursor-pointer"
                  title="Удалить запись"
                >
                  <Trash2 size={15} />
                </button>
                <button
                  type="button"
                  onClick={stopRecording}
                  className="p-1.5 px-2.5 bg-rose-600 hover:bg-rose-700 text-white rounded-full transition-all cursor-pointer text-xs font-semibold flex items-center gap-1.5"
                  title="Завершить и отправить"
                >
                  <Square size={10} fill="currentColor" />
                  <span>Отправить</span>
                </button>
              </div>
            </div>
          ) : isTranscribing ? (
            /* Active audio transcription loading indicator */
            <div className="flex-1 flex items-center justify-between px-3.5 py-3 bg-blue-50/10 rounded-xl animate-fade">
              <div className="flex items-center gap-2.5 min-w-0">
                <RefreshCw size={14} className="text-[#1b5df7] animate-spin shrink-0" />
                <span className="text-xs sm:text-sm font-semibold text-zinc-700 font-sans">Транскрибирую голос через Gemini AI...</span>
              </div>
              <div className="text-[9px] bg-blue-50 text-[#1b5df7] border border-blue-100 px-2.5 py-0.5 rounded-full font-bold animate-pulse select-none uppercase tracking-wider">
                Секунду
              </div>
            </div>
          ) : (
            /* Standard chat input form */
            <>
              {/* Selected attachments inline preview gallery */}
              {selectedFiles.length > 0 && (
                <div className="flex flex-wrap gap-2 p-2 px-3 border-b border-zinc-200/60 bg-zinc-100/50 rounded-t-2xl">
                  {selectedFiles.map((file, idx) => {
                    const isImg = file.type.startsWith("image/");
                    return (
                      <div key={idx} className="relative group flex items-center gap-2 p-1.5 pr-2.5 bg-white border border-zinc-200 rounded-xl max-w-[200px] shrink-0 shadow-3xs animate-fade">
                        {isImg ? (
                          <img
                            src={file.base64}
                            alt={file.name}
                            className="w-8 h-8 rounded-lg object-cover bg-zinc-100 border border-zinc-150"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-150 flex items-center justify-center text-[#1b5df7] shrink-0 font-sans">
                            <FileText size={15} />
                          </div>
                        )}
                        
                        <div className="min-w-0 flex-1 font-sans">
                          <div className="text-[11px] font-semibold text-zinc-800 truncate leading-snug">
                            {file.name}
                          </div>
                          <div className="text-[9px] text-zinc-400 font-mono">
                            {file.size ? `${(file.size / 1024).toFixed(1)} КБ` : "файл"}
                          </div>
                        </div>

                        {/* Close/Remove attachment */}
                        <button
                          type="button"
                          onClick={() => handleRemoveFile(idx)}
                          className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-zinc-700 hover:bg-zinc-900 border border-white text-white rounded-full flex items-center justify-center cursor-pointer transition-colors shadow-3xs text-[9px]"
                        >
                          <X size={9} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Hidden File Input Selector */}
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                multiple
                className="hidden"
              />

              <textarea
                ref={textareaRef}
                rows={3}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={isLoading ? "Дождитесь ответа..." : "Спросите о чем угодно... (Ctrl+Enter)"}
                disabled={isLoading}
                className="flex-1 max-h-44 px-3 py-2 text-zinc-900 text-sm placeholder-zinc-400 bg-transparent border-0 focus:outline-hidden focus:ring-0 resize-none font-sans leading-relaxed text-left min-h-[72px]"
              />

              {/* Lower dynamic buttons (DeepThink & Search selectors) */}
              <div className="pt-2 px-2.5 flex items-center justify-between border-t border-zinc-150/40 shrink-0">
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Brain (DeepThink R1) Toggle button */}
                  <button
                    onClick={onToggleDeepThink}
                    disabled={isLoading}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-semibold cursor-pointer select-none transition-all font-sans ${
                      deepThink
                        ? "bg-[#ebf1fc] text-[#1b5df7] border-[#d8e3fd] hover:bg-[#e0e9fa]"
                        : "bg-white text-zinc-500 border-zinc-200 hover:bg-zinc-100 hover:text-zinc-800"
                    }`}
                  >
                    <Brain size={13} className={deepThink ? "text-[#1b5df7] animate-pulse" : "text-zinc-400"} />
                    <span>DeepThink (R1)</span>
                  </button>

                  {/* Globe (WebSearch) Toggle button */}
                  <button
                    onClick={onToggleWebSearch}
                    disabled={isLoading}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-semibold cursor-pointer select-none transition-all font-sans ${
                      webSearch
                        ? "bg-blue-50 text-indigo-700 border-blue-200 hover:bg-blue-100"
                        : "bg-white text-zinc-500 border-zinc-200 hover:bg-zinc-100 hover:text-zinc-800"
                    }`}
                  >
                    <Globe size={13} className={webSearch ? "text-indigo-600 animate-spin-slow" : "text-zinc-400"} />
                    <span>Поиск в сети</span>
                  </button>
                </div>

                {/* Send mechanisms on far right */}
                <div className="flex items-center gap-1.5">
                  {/* Attachment Paperclip button */}
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isLoading}
                    className="p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 rounded-full transition-all cursor-pointer shrink-0"
                    title="Прикрепить файлы или изображения"
                  >
                    <Paperclip size={14} />
                  </button>

                  {/* Recording button selector */}
                  <button
                    type="button"
                    onClick={startRecording}
                    disabled={isLoading}
                    className="p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 rounded-full transition-all cursor-pointer shrink-0"
                    title="Записать голосовое сообщение"
                  >
                    <Mic size={14} />
                  </button>

                  <button
                    type="button"
                    onClick={handleSendText}
                    disabled={isLoading || (!input.trim() && selectedFiles.length === 0)}
                    className="p-1.5 bg-[#1b5df7] text-white rounded-full hover:bg-blue-700 disabled:bg-zinc-150 disabled:text-zinc-400 transition-all cursor-pointer shadow-3xs"
                    title="Отправить (Enter)"
                  >
                    <Send size={13} />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </footer>
  );
});

ChatInput.displayName = "ChatInput";
