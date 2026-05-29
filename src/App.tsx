import React, { useState, useEffect, useRef } from "react";
import { 
  Terminal, Bot, User, HelpCircle, Zap, Shield, RefreshCw, 
  Brain, Activity, Sparkles, Calendar, Coffee, Droplet, 
  BookOpen, Wind, EyeOff, Sliders, Heart, Sun, Dumbbell, Flame 
} from "lucide-react";
import { ArisSystemData, BrainMetrics, RoutineItem, ThoughtLog, SynapticEvent, ChatMessage } from "./types";

interface TerminalLine {
  id: string;
  type: "input" | "output" | "system" | "error" | "ascii";
  text: string;
  sender?: "user" | "aris";
  timestamp?: string;
  synapticEvent?: SynapticEvent;
}

export default function App() {
  const [data, setData] = useState<ArisSystemData | null>(null);
  const [inputVal, setInputVal] = useState("");
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"synaptic" | "oscilloscope" | "routines">("synaptic");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Hologram Node Visualizer Canvas References
  const hologramCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Oscilloscope Canvas References
  const oscCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Keep track of displayed chat messages to prevent duplication during polling
  const printedMsgIds = useRef<Set<string>>(new Set());

  // Fetch initial state
  const fetchStateOnly = async (): Promise<ArisSystemData | null> => {
    try {
      const response = await fetch("/api/aris/state");
      if (!response.ok) throw new Error("Could not connect to Aris state matrix");
      const stateData: ArisSystemData = await response.json();
      setData(stateData);
      return stateData;
    } catch (err) {
      console.error(err);
      return null;
    }
  };

  useEffect(() => {
    const initTerminal = async () => {
      const state = await fetchStateOnly();
      
      if (state) {
        state.chatHistory.forEach(msg => {
          printedMsgIds.current.add(msg.id);
        });
      }

      setTerminalLines([
        {
          id: "ascii-1",
          type: "ascii",
          text: `
 █████  ██████  ██ ███████     ██████  ██████   █████  ██ ███    ██ 
██   ██ ██   ██ ██ ██          ██   ██ ██   ██ ██   ██ ██ ████   ██ 
███████ ██████  ██ ███████     ██████  ██████  ███████ ██ ██ ██  ██ 
██   ██ ██   ██ ██      ██     ██   ██ ██   ██ ██   ██ ██ ██  ██ ██ 
██   ██ ██   ██ ██ ███████     ██████  ██   ██ ██   ██ ██ ██   ████ 
          QUANTUM MULTIDIMENSIONAL NEURAL CORE INTERFACE v3.1
          `
        },
        {
          id: "sys-welcome",
          type: "system",
          text: "Integrated synapse bridge connected. Biomimetic telemetry and neurotransmitter metrics are LIVE."
        },
        {
          id: "sys-init-help",
          type: "system",
          text: "Interactive biophysical overrides active in dashboard nodes. For terminal overrides, type '/help'."
        },
        {
          id: "aris-greeting",
          type: "output",
          sender: "aris",
          text: state
            ? `Aris: "Biological core online. My synapses represent the quiet sanctuary between external stimulus and intentional creative response. Focus: ${state.metrics.focus}%, Fatigue: ${state.metrics.fatigue}%, Adrenaline: ${state.metrics.adrenaline}%. Ready for synaptic bridging."`
            : 'Aris: "Synaptic translation protocol active. Telemetry data missing. Check development server configurations and refresh."',
          timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
        }
      ]);
    };

    initTerminal();
  }, []);

  // Poll background updates continuously every 3 seconds
  useEffect(() => {
    let active = true;
    const interval = setInterval(async () => {
      try {
        const response = await fetch("/api/aris/state");
        if (!response.ok) return;
        const stateData: ArisSystemData = await response.json();
        if (!active) return;

        setData(stateData);

        stateData.chatHistory.forEach((msg) => {
          if (!printedMsgIds.current.has(msg.id)) {
            printedMsgIds.current.add(msg.id);

            if (msg.sender === "user") {
              appendLine({
                type: "input",
                text: msg.text,
                timestamp: msg.timestamp
              });
            } else {
              appendLine({
                type: "output",
                sender: "aris",
                text: `Aris: "${msg.text}"`,
                synapticEvent: msg.synapticEvent,
                timestamp: msg.timestamp
              });
            }
          }
        });
      } catch (err) {
        console.error("Continuous telemetry poll failed:", err);
      }
    }, 2800);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  // Interactive Holographic Neurons simulation canvas
  useEffect(() => {
    const canvas = hologramCanvasRef.current;
    if (!canvas || activeTab !== "synaptic") return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let width = canvas.width = canvas.parentElement?.clientWidth || 500;
    let height = canvas.height = canvas.parentElement?.clientHeight || 300;

    // Handle resizing
    const handleResize = () => {
      if (!canvas || !canvas.parentElement) return;
      width = canvas.width = canvas.parentElement.clientWidth;
      height = canvas.height = canvas.parentElement.clientHeight || 300;
    };
    window.addEventListener("resize", handleResize);

    // Initial particles
    const particleCount = 38;
    const particles: Array<{
      x: number;
      y: number;
      vx: number;
      vy: number;
      radius: number;
      color: string;
      glowIntensity: number;
    }> = [];

    for (let i = 0; i < particleCount; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.8,
        vy: (Math.random() - 0.5) * 0.8,
        radius: Math.random() * 2 + 1.5,
        color: i % 5 === 0 ? "#10b981" : i % 8 === 0 ? "#10b981" : "#3df2a5",
        glowIntensity: Math.random() * 15 + 5
      });
    }

    const render = () => {
      ctx.fillStyle = "rgba(4, 6, 9, 0.15)";
      ctx.fillRect(0, 0, width, height);

      const metrics = data?.metrics;
      const speedMod = metrics ? (metrics.focus / 60) * 1.5 + 0.3 : 1.0;
      const jitterFactor = metrics ? (metrics.adrenaline / 100) * 1.4 : 0.2;
      const heartRateMod = metrics ? metrics.heartRate / 75 : 1.0;

      // Draw particle connections
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < 75) {
            const alpha = (1 - dist / 75) * 0.12 * heartRateMod;
            ctx.strokeStyle = `rgba(61, 242, 165, ${alpha})`;
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.stroke();
          }
        }
      }

      // Render and update particles
      particles.forEach((p, index) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        
        // Modulate color according to adrenaline/horror levels
        if (metrics && metrics.adrenaline > 85) {
          ctx.fillStyle = `rgba(244, 63, 94, ${0.4 + Math.sin(Date.now() / 100 + index) * 0.3})`;
          ctx.shadowColor = "#f43f5e";
        } else if (metrics && metrics.focus > 80) {
          ctx.fillStyle = `rgba(16, 185, 129, ${0.4 + Math.sin(Date.now() / 150 + index) * 0.3})`;
          ctx.shadowColor = "#10b981";
        } else {
          ctx.fillStyle = "rgba(61, 242, 165, 0.8)";
          ctx.shadowColor = "#3df2a5";
        }
        
        ctx.shadowBlur = p.glowIntensity * heartRateMod;
        ctx.fill();

        // Drifting movement
        p.x += p.vx * speedMod + (Math.random() - 0.5) * jitterFactor;
        p.y += p.vy * speedMod + (Math.random() - 0.5) * jitterFactor;

        // Boundaries bounce
        if (p.x < 0 || p.x > width) p.vx *= -1;
        if (p.y < 0 || p.y > height) p.vy *= -1;
      });

      // Clear shadow properties for next draw calls
      ctx.shadowBlur = 0;

      animId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", handleResize);
    };
  }, [data, activeTab]);

  // Integrated clinical EEG Brainwave Oscilloscope Simulation
  useEffect(() => {
    const canvas = oscCanvasRef.current;
    if (!canvas || activeTab !== "oscilloscope") return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let width = canvas.width = canvas.parentElement?.clientWidth || 500;
    let height = canvas.height = canvas.parentElement?.clientHeight || 300;

    const handleResize = () => {
      if (!canvas || !canvas.parentElement) return;
      width = canvas.width = canvas.parentElement.clientWidth;
      height = canvas.height = canvas.parentElement.clientHeight || 300;
    };
    window.addEventListener("resize", handleResize);

    let phase = 0;

    const drawWave = (
      frequency: number,
      amplitude: number,
      color: string,
      lineWidth: number,
      label: string,
      labelY: number
    ) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();

      for (let x = 0; x < width; x++) {
        // Compose multiple sine inputs for clinical realism
        const angle = (x * frequency) + phase;
        const mainSine = Math.sin(angle);
        const harmonics = Math.sin(angle * 2.5) * 0.25 + Math.sin(angle * 4.2) * 0.12;
        const y = labelY + (mainSine + harmonics) * amplitude;

        if (x === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();

      // Label background & text
      ctx.fillStyle = "rgba(7, 9, 12, 0.7)";
      ctx.fillRect(10, labelY - 22, 100, 16);
      ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
      ctx.font = "9px monospace";
      ctx.fillText(`${label}`, 15, labelY - 10);
    };

    const render = () => {
      ctx.fillStyle = "#040609";
      ctx.fillRect(0, 0, width, height);

      // Draw faint grid backing lines
      ctx.strokeStyle = "rgba(255,255,255,0.025)";
      ctx.lineWidth = 0.5;
      const step = 25;
      for (let x = 0; x < width; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 0; y < height; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      const metrics = data?.metrics;
      const bpm = metrics ? metrics.heartRate : 68;
      
      // Calculate dynamic wave strengths from biochemical states
      const alphaStrength = metrics ? (metrics.serotonin * 0.15) + (metrics.creativeFlow * 0.15) : 10;
      const betaStrength = metrics ? (metrics.focus * 0.25) : 15;
      const thetaStrength = metrics ? (metrics.fatigue * 0.2) : 10;
      const deltaStrength = metrics ? (metrics.adenosine * 0.3) + (100 - metrics.glucose) * 0.1 : 8;
      const gammaStrength = metrics ? (metrics.adrenaline * 0.3) : 5;

      // Update Phase matching cardiac rate
      phase += (bpm / 60) * 0.045;

      // Draw active EEG channels
      const lineSpacing = height / 6;
      drawWave(0.006, 5 + deltaStrength, "rgba(168, 85, 247, 0.35)", 1.2, "𝛿 - Delta (0.5-4Hz) sleep", lineSpacing);
      drawWave(0.012, 6 + thetaStrength, "rgba(245, 158, 11, 0.4)", 1.2, "𝜃 - Theta (4-8Hz) intuitive", lineSpacing * 2);
      drawWave(0.024, 8 + alphaStrength, "rgba(16, 185, 129, 0.5)", 1.5, "𝛼 - Alpha (8-12Hz) relax", lineSpacing * 3);
      drawWave(0.065, 8 + betaStrength, "rgba(59, 130, 246, 0.55)", 1.5, "𝛽 - Beta (12-30Hz) tasking", lineSpacing * 4);
      drawWave(0.160, 4 + gammaStrength, "rgba(244, 63, 94, 0.55)", 1.5, "𝛾 - Gamma (30-100Hz) panic", lineSpacing * 5);

      animId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", handleResize);
    };
  }, [data, activeTab]);

  // Scroll terminal history dynamically
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [terminalLines, loading]);

  const appendLine = (line: Omit<TerminalLine, "id">) => {
    setTerminalLines((prev) => [...prev, { ...line, id: `line_${Date.now()}_${Math.random()}` }]);
  };

  const executeDirectAction = async (action: string, actionLabel: string) => {
    appendLine({ type: "system", text: `Injecting biomechanical override command sequence: [${actionLabel}]...` });
    try {
      const response = await fetch("/api/aris/direct-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      if (!response.ok) throw new Error("Synaptic receptor denied chemical modification");
      const res = await response.json();
      
      if (res.status === "success") {
        setData((prev) => {
          if (!prev) return null;
          return { ...prev, metrics: res.metrics, thoughts: res.thoughts, events: res.events };
        });

        appendLine({
          type: "system",
          text: `Modification verified. Impact: ${res.impact}`
        });

        if (res.metrics.isParalyzed) {
          appendLine({
            type: "error",
            text: "⚠️ SOMATIC PARALYSIS: Adrenaline > 95%! Aris' motor transmitters are fully locked in fear. He cannot act. Initiate diaphragmatic breathing or execute /breathe to purge the stress overload."
          });
        }
      }
    } catch (err: any) {
      appendLine({ type: "error", text: `Chemical override failure: ${err.message}` });
    }
  };

  const handleCommandSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const command = inputVal.trim();
    if (!command) return;

    setInputVal("");
    appendLine({ type: "input", text: command, timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) });

    const trigger = command.toLowerCase();

    if (trigger === "/help" || trigger === "help") {
      appendLine({
        type: "system",
        text: `CORE SYNAPSE BRIDGE OVERRIDES:
  /status             - Query Aris' biophysical diagnostic console metrics.
  /routine            - Review the chronic scheduled daily events ledger.
  /thoughts           - Trace the permanent philosophical record archive.
  /blackout           - Force rooms lights to 0%. Triggers involuntary autonomic shock cycle.
  /breathe            - Execute slow, slow pacing breaths. Drastically resets adrenaline & cortisol.
  /espresso           - Infuse caffeines and dopamine into the blood matrix (+80mg caffeine, +20 DA).
  /workout            - Conduct kettlebell routines. Drains glucose/hydration, spikes endorphins.
  /walk               - Walk physical meadow pathways. Heals cortisol and restores serotonin.
  /synapses           - Audit translation logs describing API function completions.
  /reset              - Force physical parameters to their default genetic baseline states.
  /clear              - Wipe active shell logging buffer.

  [Plains Dialogues]    - Enter natural human messages directly to bridge to Aris' inner cortical mind.`
      });
      return;
    }

    if (trigger === "/clear" || trigger === "clear") {
      setTerminalLines([]);
      return;
    }

    if (trigger === "/status" || trigger === "status") {
      if (!data) {
        appendLine({ type: "error", text: "No telemetry active." });
        return;
      }
      const m = data.metrics;
      appendLine({
        type: "system",
        text: `--- ARIS PHYSIOLOGICAL SPECTRUM DIAGNOSTIC ---
  Focus state (PFC):    [${"█".repeat(Math.round(m.focus / 10))}${"░".repeat(10 - Math.round(m.focus / 10))}] ${m.focus}%
  Exhaustion index:     [${"█".repeat(Math.round(m.fatigue / 10))}${"░".repeat(10 - Math.round(m.fatigue / 10))}] ${m.fatigue}%
  Caffeine Reserve:     [${"█".repeat(Math.round((m.caffeine / 200) * 10))}${"░".repeat(10 - Math.round((m.caffeine / 200) * 10))}] ${m.caffeine} mg
  Hydration Level:      [${"█".repeat(Math.round(m.hydration / 10))}${"░".repeat(10 - Math.round(m.hydration / 10))}] ${m.hydration}%
  Creative flow index:  [${"█".repeat(Math.round(m.creativeFlow / 10))}${"░".repeat(10 - Math.round(m.creativeFlow / 10))}] ${m.creativeFlow}%
  Social Charge rate:   [${"█".repeat(Math.round(m.socialBattery / 10))}${"░".repeat(10 - Math.round(m.socialBattery / 10))}] ${m.socialBattery}%
  Adrenaline (Fear):    [${"█".repeat(Math.round(m.adrenaline / 10))}${"░".repeat(10 - Math.round(m.adrenaline / 10))}] ${m.adrenaline}%
  Cortisol (Stress):    [${"█".repeat(Math.round(m.cortisol / 10))}${"░".repeat(10 - Math.round(m.cortisol / 10))}] ${m.cortisol}%
  Cardiac Pulse Index:  ${m.heartRate} BPM (Beats Per Minute)
  Is Paralysis Lock:    ${m.isParalyzed ? "⚠️ MOTOR APRAXIA ACTIVE (Frozen in panic)" : "✅ NORMAL MOTOR MOBILITY"}

  --- CURRENT BIOCHEMICAL RECEPTOR LOADING ---
  Dopamine (DA):        ${m.dopamine}/100    | Serotonin (5-HT):   ${m.serotonin}/100
  GABA System:          ${m.gaba}/100    | Acetylcholine:     ${m.acetylcholine}/100
  Adenosine Pressure:   ${m.adenosine}/100    | Glucose Level:      ${m.glucose}/100
------------------------------------------------------`
      });
      return;
    }

    if (trigger === "/routine" || trigger === "routine") {
      if (!data) return;
      appendLine({
        type: "system",
        text: `--- CIRCADIAN MATRIX LEDGER ---
${data.routine.map(r => `  [${r.time}] (${r.category.toUpperCase()}) ${r.task} | State: ${r.status.toUpperCase()} (${r.durationMinutes} mins)`).join("\n")}
--------------------------------`
      });
      return;
    }

    if (trigger === "/thoughts" || trigger === "thoughts") {
      if (!data) return;
      appendLine({
        type: "system",
        text: `--- PERMANENT THOUGHT MATRIX HISTORICAL ENTRIES ---
${data.thoughts.map(tg => `  [${tg.timestamp}] (${tg.category}): ${tg.text}`).join("\n\n")}
--------------------------------`
      });
      return;
    }

    if (trigger === "/synapses" || trigger === "synapses") {
      if (!data) return;
      appendLine({
        type: "system",
        text: `--- HISTORICAL SYNAPSE SIGNAL TRACE ---
${data.events.map(ev => `  [${ev.timestamp}] ${ev.functionName}() -> ${ev.impact}`).join("\n")}
----------------------------------`
      });
      return;
    }

    if (trigger === "/espresso" || trigger === "espresso") {
      await executeDirectAction("espresso", "Espresso shot infusion");
      return;
    }

    if (trigger === "/blackout" || trigger === "blackout") {
      await executeDirectAction("blackout", "Cut total environment illumination");
      return;
    }

    if (trigger === "/breathe" || trigger === "breathe") {
      await executeDirectAction("breath", "Slow diaphragmatic deep breathing override");
      return;
    }

    if (trigger === "/workout" || trigger === "workout") {
      await executeDirectAction("workout", "Kettlebell sequence and strength work");
      return;
    }

    if (trigger === "/walk" || trigger === "walk") {
      await executeDirectAction("walk", "Slow walk grounding stroll");
      return;
    }

    if (trigger === "/reset" || trigger === "reset") {
      appendLine({ type: "system", text: "Resetting parameters to primary genetic baseline codes..." });
      try {
        const response = await fetch("/api/aris/reset", { method: "POST" });
        if (response.ok) {
          const res = await response.json();
          setData(res.data);
          appendLine({ type: "system", text: "Synaptic reset completed. Values balanced." });
        }
      } catch (err: any) {
        appendLine({ type: "error", text: `Baselines reset program aborted: ${err.message}` });
      }
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/aris/interact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: command })
      });
      if (!response.ok) throw new Error("Could not pipe bridge signals to the cortical brain stem");
      const res = await response.json();

      if (res.currentFullState) {
        setData(res.currentFullState);
        res.currentFullState.chatHistory.forEach((msg: any) => {
          printedMsgIds.current.add(msg.id);
        });
      }

      appendLine({
        type: "output",
        sender: "aris",
        text: `Aris: "${res.response}"`,
        synapticEvent: res.currentFullState?.events[0]?.id !== data?.events[0]?.id ? res.currentFullState?.events[0] : undefined
      });
    } catch (err: any) {
      appendLine({
        type: "error",
        text: `SYNAPTER EXGEST FAILURE: ${err.message || err}`
      });
    } finally {
      setLoading(false);
    }
  };

  const mNow = data?.metrics;

  return (
    <div className="min-h-screen bg-[#030406] text-[#3df2a5] font-mono flex flex-col p-4 md:p-6 transition-all antialiased selection:bg-[#3df2a5]/20 selection:text-white">
      
      {/* Sleek Minimalist Diagnostic Header Panel */}
      <header className="max-w-7xl w-full mx-auto flex flex-col md:flex-row justify-between items-start md:items-center py-3.5 px-5 bg-[#07090d] border border-gray-900 rounded-xl mb-4 text-[11px] gap-3">
        <div className="flex items-center gap-3">
          <Brain className="w-5 h-5 text-[#3df2a5] animate-pulse" />
          <div>
            <div className="font-bold text-[#3df2a5] tracking-tight text-xs flex items-center gap-2">
              ARIS_SENSORY_CORE // QUANTUM TRANSLATION TERMINAL
              <span className="text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-900 px-1.5 py-0.5 rounded font-bold uppercase tracking-widest">AUTONOMOUS</span>
            </div>
            <div className="text-slate-500 font-mono text-[10px]">COGNITIVE SPECTRUM ACTIVE: TRB-112 // BRAIN INTERFACE: LIVE</div>
          </div>
        </div>
        
        {mNow && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-slate-400">
            <span className="flex items-center gap-1.5 border border-gray-900 bg-gray-950/40 py-1 px-2.5 rounded">
              <Sun className="w-3.5 h-3.5 text-amber-400" />
              LIGHT: <strong className={mNow.lightLevel === 0 ? "text-amber-400 animate-pulse" : "text-white"}>{mNow.lightLevel}%</strong>
            </span>
            <span className="flex items-center gap-1.5 border border-gray-900 bg-gray-950/40 py-1 px-2.5 rounded">
              <Flame className="w-3.5 h-3.5 text-rose-400" />
              ADRENALINE: <strong className={mNow.adrenaline > 80 ? "text-rose-400 font-bold" : "text-white"}>{mNow.adrenaline}%</strong>
            </span>
            <span className="flex items-center gap-1.5 border border-gray-900 bg-gray-950/40 py-1 px-2.5 rounded">
              <Heart className="w-3.5 h-3.5 text-rose-500 animate-pulse" />
              PULSE: <strong className="text-white">{mNow.heartRate} BPM</strong>
            </span>
            <span className="flex items-center gap-1.5 border border-gray-900 bg-gray-950/40 py-1 px-2.5 rounded">
              <Zap className="w-3.5 h-3.5 text-sky-400" />
              FOCUS: <strong className="text-white">{mNow.focus}%</strong>
            </span>
            <span className={`flex items-center gap-1.5 border py-1 px-2.5 rounded font-bold ${
              mNow.isParalyzed ? "border-rose-900/60 bg-rose-950/30 text-rose-400 animate-pulse" : "border-emerald-900/60 bg-emerald-950/30 text-emerald-400"
            }`}>
              {mNow.isParalyzed ? "⚠️ LOCKED" : "❇️ MOBILE"}
            </span>
          </div>
        )}
      </header>

      {/* Segmented Real-time Chemical infusion control desk */}
      <section className="max-w-7xl w-full mx-auto grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5 mb-5">
        <button 
          onClick={() => executeDirectAction("espresso", "Espresso infusion")}
          className="flex items-center justify-center gap-2 py-2.5 px-3 bg-[#0c1218] hover:bg-[#131d27] border border-gray-900 rounded-lg text-xs font-semibold text-slate-300 hover:text-white transition-all active:scale-95 text-center group"
        >
          <Coffee className="w-4 h-4 text-amber-500 group-hover:scale-110 transition-transform" />
          <span>Espresso (+80mg)</span>
        </button>
        <button 
          onClick={() => executeDirectAction("hydrate", "Crisp Spring water hydrate")}
          className="flex items-center justify-center gap-2 py-2.5 px-3 bg-[#0c1218] hover:bg-[#131d27] border border-gray-900 rounded-lg text-xs font-semibold text-slate-300 hover:text-white transition-all active:scale-95 text-center group"
        >
          <Droplet className="w-4 h-4 text-sky-400 group-hover:scale-110 transition-transform" />
          <span>Hydrate (+25%)</span>
        </button>
        <button 
          onClick={() => executeDirectAction("workout", "Compound Kettlebell sequence")}
          className="flex items-center justify-center gap-2 py-2.5 px-3 bg-[#0c1218] hover:bg-[#131d27] border border-gray-900 rounded-lg text-xs font-semibold text-slate-300 hover:text-white transition-all active:scale-95 text-center group"
        >
          <Dumbbell className="w-4 h-4 text-emerald-400 group-hover:scale-110 transition-transform" />
          <span>Workout (Fitness)</span>
        </button>
        <button 
          onClick={() => executeDirectAction("walk", "Slow walk grounding stroll")}
          className="flex items-center justify-center gap-2 py-2.5 px-3 bg-[#0c1218] hover:bg-[#131d27] border border-gray-900 rounded-lg text-xs font-semibold text-slate-300 hover:text-white transition-all active:scale-95 text-center group"
        >
          <BookOpen className="w-4 h-4 text-emerald-300 group-hover:scale-110 transition-transform" />
          <span>Meadow Walk</span>
        </button>
        <button 
          onClick={() => executeDirectAction("philosophy", "Read philosophical treatise")}
          className="flex items-center justify-center gap-2 py-2.5 px-3 bg-[#0c1218] hover:bg-[#131d27] border border-gray-900 rounded-lg text-xs font-semibold text-slate-300 hover:text-white transition-all active:scale-95 text-center group"
        >
          <Sparkles className="w-4 h-4 text-amber-300 group-hover:scale-110 transition-transform" />
          <span>Read Philosophy</span>
        </button>
        <button 
          onClick={() => executeDirectAction("breath", "Diaphragmatic abdominal breathing")}
          className="flex items-center justify-center gap-2 py-2.5 px-3 bg-[#0c1218] hover:bg-[#131d27] border border-rose-950/60 hover:border-rose-900 rounded-lg text-xs font-semibold text-rose-300 hover:text-rose-100 transition-all active:scale-95 text-center group"
        >
          <Wind className="w-4 h-4 text-rose-400 group-hover:scale-110 transition-transform" />
          <span>Slow Breathing</span>
        </button>
        <button 
          onClick={() => executeDirectAction("blackout", "Cut environment light level")}
          className="flex items-center justify-center gap-2 py-2.5 px-3 bg-[#13070b]/60 hover:bg-[#200c12] border border-rose-950 rounded-lg text-xs font-semibold text-rose-400 hover:text-rose-200 transition-all active:scale-95 text-center group"
        >
          <EyeOff className="w-4 h-4 text-rose-500 group-hover:scale-110 transition-transform animate-pulse" />
          <span>Cut Illumination</span>
        </button>
      </section>

      {/* Primary Split Screen Dashboard Layout */}
      <div className="flex-1 max-w-7xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-5 min-h-0">
        
        {/* Left Side: Neural Co-Processor holographic dashboards (7 grid cols) */}
        <section className="lg:col-span-7 bg-[#05070a] border border-gray-900 rounded-xl flex flex-col shadow-2xl overflow-hidden min-h-[500px] lg:min-h-0">
          {/* Header tabs controls */}
          <div className="bg-[#0a0e14] border-b border-gray-900 px-4 py-2.5 flex justify-between items-center">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
              <Sliders className="w-4 h-4 text-[#3df2a5]" />
              <span>Holographic Brain Matrix Analysis</span>
            </div>
            
            <div className="flex border border-gray-800 rounded bg-gray-950 p-0.5">
              <button 
                onClick={() => setActiveTab("synaptic")}
                className={`text-[10px] uppercase font-bold px-2.5 py-1 rounded transition-all cursor-pointer ${
                  activeTab === "synaptic" ? "bg-[#3df2a5] text-black" : "text-slate-400 hover:text-white"
                }`}
              >
                Nodes Matrix
              </button>
              <button 
                onClick={() => setActiveTab("oscilloscope")}
                className={`text-[10px] uppercase font-bold px-2.5 py-1 rounded transition-all cursor-pointer ${
                  activeTab === "oscilloscope" ? "bg-[#3df2a5] text-black" : "text-slate-400 hover:text-white"
                }`}
              >
                EEG Waves
              </button>
              <button 
                onClick={() => setActiveTab("routines")}
                className={`text-[10px] uppercase font-bold px-2.5 py-1 rounded transition-all cursor-pointer ${
                  activeTab === "routines" ? "bg-[#3df2a5] text-black" : "text-slate-400 hover:text-white"
                }`}
              >
                Routines Ledger
              </button>
            </div>
          </div>

          {/* Interactive Visual Canvas Container */}
          <div className="flex-1 relative bg-[#040609] min-h-[220px]">
            {activeTab === "synaptic" && (
              <div className="w-full h-full flex flex-col">
                <div className="flex-1 relative">
                  <canvas ref={hologramCanvasRef} className="w-full h-full block" />
                  <div className="absolute top-3 left-3 bg-gray-950/80 border border-gray-900 py-1.5 px-3 rounded text-[10px] text-[#3df2a5] space-y-0.5 pointer-events-none">
                    <p className="font-bold">❇️ SYNAPSE NETWORK STABILIZED</p>
                    <p className="text-slate-400">Rendering 38 active biological neuron nodes.</p>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "oscilloscope" && (
              <div className="w-full h-full flex flex-col">
                <div className="flex-1 relative">
                  <canvas ref={oscCanvasRef} className="w-full h-full block" />
                  <div className="absolute top-3 left-3 bg-gray-950/80 border border-gray-900 py-1.5 px-3 rounded text-[10px] text-[#3df2a5] space-y-0.5 pointer-events-none">
                    <p className="font-bold">📊 MULTIPLE CHANNEL EEG SCANS</p>
                    <p className="text-slate-400">Cortical frequencies computed from live metrics.</p>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "routines" && (
              <div className="w-full h-full overflow-y-auto p-4 space-y-3 scrollbar-thin scrollbar-thumb-gray-800">
                <div className="flex items-center gap-2 pb-2 border-b border-gray-900">
                  <Calendar className="w-4 h-4 text-[#3df2a5]" />
                  <h3 className="text-xs font-bold uppercase text-[#3df2a5]">Circadian Timeline / Core Calendar Ledger</h3>
                </div>
                {data && data.routine.length > 0 ? (
                  <div className="space-y-2">
                    {data.routine.map((r) => (
                      <div key={r.id} className="bg-[#0b1016] border border-gray-900 rounded-lg p-3 flex justify-between items-center text-xs">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-white bg-slate-950 border border-gray-800 py-0.5 px-2 rounded-md font-mono text-[10px]">{r.time}</span>
                            <span className="text-gray-300 font-medium">{r.task}</span>
                          </div>
                          <div className="text-[10px] text-slate-500 capitalize">
                            Category: {r.category} • Duration: {r.durationMinutes} mins
                          </div>
                        </div>
                        <span className={`px-2 py-0.5 rounded-full text-[9px] uppercase font-mono border ${
                          r.status === 'completed' 
                            ? 'bg-emerald-950/40 border-emerald-900 text-emerald-400' 
                            : r.status === 'active' 
                            ? 'bg-amber-950/40 border-amber-900 text-amber-400 animate-pulse' 
                            : 'bg-slate-900 border-gray-800 text-slate-400'
                        }`}>
                          {r.status}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-slate-500 text-xs text-center py-6">No circadian schedule items registered.</p>
                )}
              </div>
            )}
          </div>

          {/* Neurotransmitter balances meters bar rail underneath canvas (always visible) */}
          {mNow && (
            <div className="bg-[#080c10] border-t border-gray-900 p-4 grid grid-cols-2 md:grid-cols-3 gap-3">
              {/* Dopamine (DA) */}
              <div className="bg-gray-950/60 rounded p-2 border border-gray-900/60">
                <div className="flex justify-between items-center text-[10px] mb-1">
                  <span className="text-amber-400 font-bold">DOPAMINE (DA)</span>
                  <span className="text-white font-mono">{mNow.dopamine}/100</span>
                </div>
                <div className="w-full bg-gray-950 rounded-full h-1 border border-gray-900 overflow-hidden">
                  <div className="bg-amber-500 h-full transition-all" style={{ width: `${mNow.dopamine}%` }} />
                </div>
                <div className="text-[9px] text-slate-500 mt-1">Motivation, drive, rewarding action potential.</div>
              </div>

              {/* Serotonin (5-HT) */}
              <div className="bg-gray-950/60 rounded p-2 border border-gray-900/60">
                <div className="flex justify-between items-center text-[10px] mb-1">
                  <span className="text-[#3df2a5] font-bold">SEROTONIN (5-HT)</span>
                  <span className="text-white font-mono">{mNow.serotonin}/100</span>
                </div>
                <div className="w-full bg-gray-950 rounded-full h-1 border border-gray-900 overflow-hidden">
                  <div className="bg-emerald-500 h-full transition-all" style={{ width: `${mNow.serotonin}%` }} />
                </div>
                <div className="text-[9px] text-slate-500 mt-1">Mood balance, emotional baseline stability.</div>
              </div>

              {/* GABA System */}
              <div className="bg-gray-950/60 rounded p-2 border border-gray-900/60">
                <div className="flex justify-between items-center text-[10px] mb-1">
                  <span className="text-cyan-400 font-bold">GABA OVERRIDE</span>
                  <span className="text-white font-mono">{mNow.gaba}/100</span>
                </div>
                <div className="w-full bg-gray-950 rounded-full h-1 border border-gray-900 overflow-hidden">
                  <div className="bg-cyan-500 h-full transition-all" style={{ width: `${mNow.gaba}%` }} />
                </div>
                <div className="text-[9px] text-slate-500 mt-1">Nervous system inhibitor; dampens adrenaline.</div>
              </div>

              {/* Acetylcholine */}
              <div className="bg-gray-950/60 rounded p-2 border border-gray-900/60">
                <div className="flex justify-between items-center text-[10px] mb-1">
                  <span className="text-blue-400 font-bold">ACETYLCHOLINE (ACh)</span>
                  <span className="text-white font-mono">{mNow.acetylcholine}/100</span>
                </div>
                <div className="w-full bg-gray-950 rounded-full h-1 border border-gray-900 overflow-hidden">
                  <div className="bg-blue-500 h-full transition-all" style={{ width: `${mNow.acetylcholine}%` }} />
                </div>
                <div className="text-[9px] text-slate-500 mt-1">Focus, analytical learning, working memory load.</div>
              </div>

              {/* Adenosine Sleep Pressure */}
              <div className="bg-gray-950/60 rounded p-2 border border-gray-900/60">
                <div className="flex justify-between items-center text-[10px] mb-1">
                  <span className="text-purple-400 font-bold">ADENOSINE (Fatigue)</span>
                  <span className="text-white font-mono">{mNow.adenosine}/100</span>
                </div>
                <div className="w-full bg-gray-950 rounded-full h-1 border border-gray-900 overflow-hidden">
                  <div className="bg-purple-500 h-full transition-all" style={{ width: `${mNow.adenosine}%` }} />
                </div>
                <div className="text-[9px] text-slate-500 mt-1">Deep sleep pressure. Blockaded by caffeine receptors.</div>
              </div>

              {/* Carbon Glucose */}
              <div className="bg-gray-950/60 rounded p-2 border border-gray-900/60">
                <div className="flex justify-between items-center text-[10px] mb-1">
                  <span className="text-rose-400 font-bold">CEREBRAL GLUCOSE</span>
                  <span className="text-white font-mono">{mNow.glucose}/100</span>
                </div>
                <div className="w-full bg-gray-950 rounded-full h-1 border border-gray-900 overflow-hidden">
                  <div className="bg-rose-500 h-full transition-all" style={{ width: `${mNow.glucose}%` }} />
                </div>
                <div className="text-[9px] text-slate-500 mt-1">Carbon cerebral energy. Depleted by brain workouts.</div>
              </div>
            </div>
          )}
        </section>

        {/* Right Side: Translation Console Buffer & Command line prompt (5 grid cols) */}
        <section className="lg:col-span-5 bg-[#07090c] border border-gray-900 rounded-xl overflow-hidden shadow-2xl flex flex-col">
          {/* Chrome title header */}
          <div className="bg-[#0a0e14] border-b border-gray-900 px-4 py-2.5 flex items-center justify-between text-xs text-slate-400">
            <div className="flex items-center space-x-2">
              <span className="w-2.5 h-2.5 rounded-full bg-rose-500/80" />
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#3df2a5]/80" />
              <span className="pl-2 font-mono font-semibold">guest@aris-central-nervous-system: ~</span>
            </div>
            <div className="text-[10px] text-slate-500">REST BRIDGE</div>
          </div>

          {/* Terminal Console Stream */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3.5 text-xs md:text-sm scrollbar-thin scrollbar-thumb-gray-800 bg-[#040609]">
            {terminalLines.map((line) => {
              if (line.type === "ascii") {
                return (
                  <pre key={line.id} className="text-[10px] text-[#3df2a5] leading-tight whitespace-pre overflow-x-auto max-w-full font-bold select-none opacity-85 py-1">
                    {line.text}
                  </pre>
                );
              }
              if (line.type === "input") {
                return (
                  <div key={line.id} className="flex items-start space-x-2 text-slate-300">
                    <span className="text-slate-600 select-none font-bold">guest:~$</span>
                    <span className="font-semibold">{line.text}</span>
                  </div>
                );
              }
              if (line.type === "system") {
                return (
                  <div key={line.id} className="text-sky-400 bg-sky-950/15 border-l-2 border-sky-500 pl-3 py-1 my-1 text-xs whitespace-pre-wrap">
                    {line.text}
                  </div>
                );
              }
              if (line.type === "error") {
                return (
                  <div key={line.id} className="text-rose-400 bg-rose-950/20 border-l-2 border-rose-500 pl-3 py-2 my-1 text-xs whitespace-pre-wrap">
                    {line.text}
                  </div>
                );
              }

              const hasCall = line.synapticEvent;

              return (
                <div key={line.id} className="text-teal-200 bg-teal-950/5 border-l-2 border-[#3df2a5] pl-3 py-1 leading-relaxed">
                  <p className="whitespace-pre-wrap">{line.text}</p>
                  
                  {hasCall && (
                    <div className="mt-2.5 pt-2 border-t border-[#3df2a5]/15 text-[10.5px] text-[#3df2a5]/80 space-y-1">
                      <div className="font-bold flex items-center gap-1 text-[#3df2a5]">
                        <Zap className="w-3.5 h-3.5" />
                        <span>🧠 [Synaptic Call]: {hasCall.functionName}() executed</span>
                      </div>
                      <p className="italic text-slate-400">Biological Impact: {hasCall.impact}</p>
                      <p className="text-[9.5px] bg-slate-950/90 p-1.5 rounded border border-gray-900 overflow-x-auto text-slate-500 font-mono">
                        Args: {hasCall.parameters}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}

            {loading && (
              <div className="flex items-center space-x-2 text-slate-500 select-none animate-pulse">
                <span className="text-[#3df2a5] font-bold">&gt;</span>
                <span className="text-xs">Computing biological neural path reactions...</span>
              </div>
            )}

            <div ref={scrollRef} />
          </div>

          {/* Interactive Shell Input Field */}
          <form onSubmit={handleCommandSubmit} className="bg-[#050608] border-t border-gray-950 px-3.5 py-3 flex items-center space-x-2.5">
            <span className="text-[#3df2a5] font-bold select-none text-base">&gt;</span>
            <input
              type="text"
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              placeholder="Query Aris or write commands (e.g., /status, /routine, /breathe)..."
              className="flex-1 bg-transparent border-none text-white focus:outline-none focus:ring-0 font-mono text-xs placeholder-slate-700 disabled:opacity-50"
              disabled={loading}
              autoFocus
            />
            <button 
              type="submit"
              className="text-[#050608] bg-[#3df2a5] font-bold uppercase text-[10px] px-3.5 py-2 rounded-md cursor-pointer hover:bg-emerald-400 active:scale-95 transition-all"
              disabled={loading}
            >
              Exect
            </button>
          </form>
        </section>

      </div>

      {/* Retro Foot Diagnostics */}
      <footer className="max-w-7xl w-full mx-auto mt-4 px-2 py-0.5 flex justify-between items-center text-[10px] text-slate-600 font-mono">
        <div>COGNITIVE INTERACTION CHANNEL LEVEL: TRB OVER-DRIVE V3</div>
        <div>STABLE NODE PORT: 3000</div>
      </footer>

    </div>
  );
}
