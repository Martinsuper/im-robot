import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import { toUserMessage } from "../../lib/errors";
import { useStableEvent } from "../../hooks/useStableEvent";
import { textForSpeech } from "./ChatPresentation";
import type { useToast } from "../../components/feedback/toastStore";

const WHISPER_SAMPLE_RATE = 16000;

type VoiceControlOptions = {
  message: string;
  setPrompt: Dispatch<SetStateAction<string>>;
  activeTabRef: RefObject<boolean>;
  promptInputRef: RefObject<HTMLTextAreaElement | null>;
  toast: ReturnType<typeof useToast>;
};

/**
 * 语音维度：朗读播放、麦克风录音、WAV 编码与本地转写。
 * 与聊天状态只通过 message / setPrompt 交互，不持有任何会话状态。
 */
export function useVoiceControl({ message, setPrompt, activeTabRef, promptInputRef, toast }: VoiceControlOptions) {
  const [voiceAvailable, setVoiceAvailable] = useState(true);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const speechRevision = useRef(0);
  const [isListening, setIsListening] = useState(false);
  const [isTranscribingVoice, setIsTranscribingVoice] = useState(false);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceAudioContextRef = useRef<AudioContext | null>(null);
  const voiceProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const voiceSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const voiceSamplesRef = useRef<Float32Array[]>([]);
  const voiceSampleRateRef = useRef(WHISPER_SAMPLE_RATE);

  useEffect(() => {
    void runCommand("get_data_health")
      .then(health => setVoiceAvailable(health?.speechRecognition !== false))
      .catch(error => console.error("[capabilities]", error));
  }, []);

  async function toggleSpeech() {
    const revision = ++speechRevision.current;
    if (isSpeaking) {
      if (isTauriRuntime) {
        await runCommand("stop_local_speech");
      } else {
        window.speechSynthesis?.cancel();
      }
      setIsSpeaking(false);
      return;
    }
    if (isTauriRuntime) {
      try {
        setIsSpeaking(true);
        const finished = await runCommand("speak_local_text", { text: message });
        if (revision === speechRevision.current) setIsSpeaking(!finished);
      } catch (error) {
        if (revision !== speechRevision.current) return;
        setIsSpeaking(false);
        const errorText = toUserMessage(error, "朗读失败，请重试。");
        if (!errorText.includes("已取消朗读")) toast.error(errorText);
      }
      return;
    }
    if (!("speechSynthesis" in window)) {
      toast.info("当前环境不支持朗读。");
      return;
    }
    const spokenMessage = textForSpeech(message).trim();
    if (!spokenMessage) {
      toast.info("没有可朗读的文字内容。");
      return;
    }
    const utterance = new SpeechSynthesisUtterance(spokenMessage);
    utterance.lang = "zh-CN";
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    setIsSpeaking(true);
  }

  function appendSpeechText(base: string, text: string) {
    const normalizedText = text.trim();
    if (!normalizedText) return base;
    if (!base.trim()) return normalizedText;
    return `${base.trimEnd()} ${normalizedText}`;
  }

  function encodeWav(samples: Float32Array[], sampleRate: number) {
    const sampleCount = samples.reduce((sum, chunk) => sum + chunk.length, 0);
    const buffer = new ArrayBuffer(44 + sampleCount * 2);
    const view = new DataView(buffer);
    let offset = 0;
    const writeString = (value: string) => {
      for (let index = 0; index < value.length; index += 1) {
        view.setUint8(offset, value.charCodeAt(index));
        offset += 1;
      }
    };
    writeString("RIFF");
    view.setUint32(offset, 36 + sampleCount * 2, true); offset += 4;
    writeString("WAVE");
    writeString("fmt ");
    view.setUint32(offset, 16, true); offset += 4;
    view.setUint16(offset, 1, true); offset += 2;
    view.setUint16(offset, 1, true); offset += 2;
    view.setUint32(offset, sampleRate, true); offset += 4;
    view.setUint32(offset, sampleRate * 2, true); offset += 4;
    view.setUint16(offset, 2, true); offset += 2;
    view.setUint16(offset, 16, true); offset += 2;
    writeString("data");
    view.setUint32(offset, sampleCount * 2, true); offset += 4;
    for (const chunk of samples) {
      for (const sample of chunk) {
        const clamped = Math.max(-1, Math.min(1, sample));
        view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
        offset += 2;
      }
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("无法读取录音数据。"));
      reader.readAsDataURL(blob);
    });
  }

  function stopVoiceStream() {
    voiceProcessorRef.current?.disconnect();
    voiceSourceRef.current?.disconnect();
    void voiceAudioContextRef.current?.close();
    voiceProcessorRef.current = null;
    voiceSourceRef.current = null;
    voiceAudioContextRef.current = null;
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    voiceStreamRef.current = null;
  }

  async function transcribeVoiceBlob(blob: Blob) {
    if (blob.size <= 44) {
      toast.info("没有录到语音内容。");
      return;
    }
    setIsTranscribingVoice(true);
    try {
      const audioDataUrl = await blobToDataUrl(blob);
      const result = await runCommand("transcribe_voice_input", {
        input: { audioDataUrl },
      });
      setPrompt((current) => appendSpeechText(current, result.text));
      promptInputRef.current?.focus();
    } catch (error) {
      toast.error(`语音转文字失败：${toUserMessage(error)}`);
    } finally {
      setIsTranscribingVoice(false);
    }
  }

  const stopVoiceRecording = useStableEvent((shouldTranscribe = true) => {
    const samples = voiceSamplesRef.current;
    const sampleRate = voiceSampleRateRef.current;
    voiceSamplesRef.current = [];
    stopVoiceStream();
    setIsListening(false);
    if (!shouldTranscribe) return;
    if (!samples.length) {
      toast.info("没有录到语音内容。");
      return;
    }
    const blob = encodeWav(samples, sampleRate);
    void transcribeVoiceBlob(blob);
  });

  async function toggleVoiceInput() {
    if (isListening) {
      stopVoiceRecording();
      return;
    }
    if (!isTauriRuntime) {
      toast.info("浏览器预览无法调用本地语音模型，请在桌面应用中使用。");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      toast.info("当前环境不支持麦克风录音。");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      voiceSamplesRef.current = [];
      voiceSampleRateRef.current = audioContext.sampleRate;
      processor.onaudioprocess = (event) => {
        voiceSamplesRef.current.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(audioContext.destination);
      voiceStreamRef.current = stream;
      voiceAudioContextRef.current = audioContext;
      voiceSourceRef.current = source;
      voiceProcessorRef.current = processor;
      setIsListening(true);
      promptInputRef.current?.focus();
    } catch (error) {
      setIsListening(false);
      stopVoiceStream();
      toast.error(`无法启动录音：${toUserMessage(error)}`);
    }
  }

  // 卸载时停止桌面端朗读；运行时判断放在稳定回调里，避免 cleanup 直接读取 ref。
  const stopLocalSpeech = useStableEvent(() => {
    if (isTauriRuntime && activeTabRef.current) void runCommand("stop_local_speech");
  });

  useEffect(() => {
    return () => {
      stopVoiceRecording(false);
      voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
      window.speechSynthesis?.cancel();
      stopLocalSpeech();
    };
  }, [stopVoiceRecording, stopLocalSpeech]);

  return {
    voiceAvailable, isSpeaking, isListening, isTranscribingVoice,
    toggleSpeech, toggleVoiceInput, stopVoiceRecording,
  };
}

export type VoiceControlApi = ReturnType<typeof useVoiceControl>;
