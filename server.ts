import express from "express";
import path from "path";
import { GoogleGenAI, Type, FunctionDeclaration, GenerateContentResponse } from "@google/genai";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { ArisSystemData, BrainMetrics, RoutineItem, ThoughtLog, SynapticEvent, ChatMessage } from "./src/types.js";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = 3000;

// Initialize the official @google/genai client with recommended headers
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

// Seed Aris' initial real-world metrics and logs
let arisData: ArisSystemData = {
  metrics: {
    focus: 74,
    fatigue: 32,
    caffeine: 60,
    hydration: 82,
    creativeFlow: 68,
    socialBattery: 70,
    heartRate: 68,
    lightLevel: 100,
    adrenaline: 15,
    cortisol: 20,
    isParalyzed: false,
    dopamine: 65,
    serotonin: 70,
    gaba: 55,
    acetylcholine: 60,
    adenosine: 25,
    glucose: 85
  },
  routine: [
    {
      id: "r1",
      time: "08:30",
      task: "Double-shot Espresso & journaling",
      category: "nutrition",
      status: "completed",
      durationMinutes: 30
    },
    {
      id: "r2",
      time: "10:00",
      task: "Deep work: Coding digital translator and cognitive core loop in React",
      category: "work",
      status: "active",
      durationMinutes: 180
    },
    {
      id: "r3",
      time: "13:30",
      task: "High-protein lunch & outdoor grounding walk",
      category: "nutrition",
      status: "pending",
      durationMinutes: 45
    },
    {
      id: "r4",
      time: "15:30",
      task: "Compound strength training (Kettlebell & Squats)",
      category: "fitness",
      status: "pending",
      durationMinutes: 60
    },
    {
      id: "r5",
      time: "18:00",
      task: "Read modern existential philosophy to calibrate mind",
      category: "leisure",
      status: "pending",
      durationMinutes: 60
    }
  ],
  thoughts: [
    {
      id: "t1",
      timestamp: "09:12",
      text: "If my nervous system is constantly reacting to external and internal stressors, does it mean my consciousness is merely a witness to an autonomic biological cascade? Or can I truly intervene through intentional action?",
      category: '哲学 (Philosophy)'
    },
    {
      id: "t2",
      timestamp: "10:24",
      text: "The caffeine-induced cognitive state can be easily graphed. Standard 60mg double espresso achieves peak focused synaptic output in exactly 45 minutes.",
      category: '技術 (Technology)'
    }
  ],
  events: [
    {
      id: "e1",
      timestamp: "08:30",
      functionName: "updateBrainState",
      parameters: JSON.stringify({ caffeine: 60, fatigue: -15, focus: 20 }),
      impact: "Morning coffee input loaded. Focus increased, sleep inertia dissolved."
    }
  ],
  chatHistory: [
    {
      id: "c1",
      sender: "aris",
      text: "Morning. I'm Aris. My focus is sharp, and my physiological stats feel completely stabilized. What are we working on prioritizing today?",
      timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
    }
  ]
};

// Reset values to healthy default
const createDefaultArisState = (): ArisSystemData => {
  return {
    metrics: {
      focus: 74,
      fatigue: 32,
      caffeine: 60,
      hydration: 82,
      creativeFlow: 68,
      socialBattery: 75,
      heartRate: 68,
      lightLevel: 100,
      adrenaline: 15,
      cortisol: 20,
      isParalyzed: false,
      dopamine: 65,
      serotonin: 70,
      gaba: 55,
      acetylcholine: 60,
      adenosine: 25,
      glucose: 85
    },
    routine: [
      {
        id: "r1",
        time: "08:30",
        task: "Double-shot Espresso & journaling",
        category: "nutrition",
        status: "completed",
        durationMinutes: 30
      },
      {
        id: "r2",
        time: "10:00",
        task: "Deep work: Coding digital translator and cognitive core loop in React",
        category: "work",
        status: "active",
        durationMinutes: 180
      },
      {
        id: "r3",
        time: "13:30",
        task: "High-protein lunch & outdoor grounding walk",
        category: "nutrition",
        status: "pending",
        durationMinutes: 45
      },
      {
        id: "r4",
        time: "15:30",
        task: "Compound strength training (Kettlebell & Squats)",
        category: "fitness",
        status: "pending",
        durationMinutes: 60
      },
      {
        id: "r5",
        time: "18:00",
        task: "Read modern existential philosophy to calibrate mind",
        category: "leisure",
        status: "pending",
        durationMinutes: 60
      }
    ],
    thoughts: [
      {
        id: "t1",
        timestamp: "09:12",
        text: "If my nervous system is constantly reacting to external and internal stressors, does it mean my consciousness is merely a witness to an autonomic biological cascade? Or can I truly intervene through intentional action?",
        category: '哲学 (Philosophy)'
      },
      {
        id: "t2",
        timestamp: "10:24",
        text: "The caffeine-induced cognitive state can be easily graphed. Standard 60mg double espresso achieves peak focused synaptic output in exactly 45 minutes.",
        category: '技術 (Technology)'
      }
    ],
    events: [
      {
        id: "e1",
        timestamp: "08:30",
        functionName: "updateBrainState",
        parameters: JSON.stringify({ caffeine: 60, fatigue: -15, focus: 20 }),
        impact: "Morning coffee input loaded. Focus increased, sleep inertia dissolved."
      }
    ],
    chatHistory: [
      {
        id: "c1",
        sender: "aris",
        text: "Morning. I'm Aris. My focus is sharp, and my physiological stats feel completely stabilized. What are we working on prioritizing today?",
        timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
      }
    ]
  };
};

// --------------------------------------------------------------------------
// Helper Functions for Brain Updates
// --------------------------------------------------------------------------
function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function triggerBrainStateChange(update: {
  focus?: number;
  fatigue?: number;
  caffeine?: number;
  hydration?: number;
  creativeFlow?: number;
  socialBattery?: number;
  heartRate?: number;
  lightLevel?: number;
  adrenaline?: number;
  cortisol?: number;
  dopamine?: number;
  serotonin?: number;
  gaba?: number;
  acetylcholine?: number;
  adenosine?: number;
  glucose?: number;
  isParalyzed?: boolean;
  actionName?: string;
}): string {
  const previous = { ...arisData.metrics };
  const action = update.actionName || "Cognitive realignment";

  // Apply elementary parameters
  if (update.caffeine !== undefined) arisData.metrics.caffeine = clamp(arisData.metrics.caffeine + update.caffeine, 0, 200);
  if (update.hydration !== undefined) arisData.metrics.hydration = clamp(arisData.metrics.hydration + update.hydration, 0, 100);
  if (update.socialBattery !== undefined) arisData.metrics.socialBattery = clamp(arisData.metrics.socialBattery + update.socialBattery, 0, 100);
  if (update.heartRate !== undefined) arisData.metrics.heartRate = clamp(arisData.metrics.heartRate + update.heartRate, 50, 160);
  
  // Autonomic involuntary metrics
  if (update.lightLevel !== undefined) arisData.metrics.lightLevel = clamp(update.lightLevel, 0, 100);
  if (update.adrenaline !== undefined) arisData.metrics.adrenaline = clamp(arisData.metrics.adrenaline + update.adrenaline, 0, 100);
  if (update.cortisol !== undefined) arisData.metrics.cortisol = clamp(arisData.metrics.cortisol + update.cortisol, 0, 100);

  // Apply neurotransmitter adjustments
  if (update.dopamine !== undefined) arisData.metrics.dopamine = clamp(arisData.metrics.dopamine + update.dopamine, 0, 100);
  if (update.serotonin !== undefined) arisData.metrics.serotonin = clamp(arisData.metrics.serotonin + update.serotonin, 0, 100);
  if (update.gaba !== undefined) arisData.metrics.gaba = clamp(arisData.metrics.gaba + update.gaba, 0, 100);
  if (update.acetylcholine !== undefined) arisData.metrics.acetylcholine = clamp(arisData.metrics.acetylcholine + update.acetylcholine, 0, 100);
  if (update.adenosine !== undefined) arisData.metrics.adenosine = clamp(arisData.metrics.adenosine + update.adenosine, 0, 100);
  if (update.glucose !== undefined) arisData.metrics.glucose = clamp(arisData.metrics.glucose + update.glucose, 0, 100);

  // --- COGNITIVE SYNTHESIS FORMULA (BIOLOGICAL CASCADE) ---
  
  // Caffeine biochem reaction: release active dopamine and norepinephrine / adenosine competitive blockade
  if (update.caffeine && update.caffeine > 0) {
    arisData.metrics.dopamine = clamp(arisData.metrics.dopamine + (update.caffeine * 0.12), 0, 100);
    arisData.metrics.adrenaline = clamp(arisData.metrics.adrenaline + (update.caffeine * 0.08), 0, 100);
    arisData.metrics.acetylcholine = clamp(arisData.metrics.acetylcholine + (update.caffeine * 0.08), 0, 100);
  }

  // GABA inhibitory action: calms stress and adrenal arousal
  if (arisData.metrics.gaba > 60) {
    const inhibitorStrength = (arisData.metrics.gaba - 50) * 0.45;
    arisData.metrics.adrenaline = clamp(arisData.metrics.adrenaline - inhibitorStrength, 0, 100);
    arisData.metrics.cortisol = clamp(arisData.metrics.cortisol - inhibitorStrength * 0.25, 0, 100);
  }

  // Direct focus calculation (PFC activation) driven by Dopamine and Acetylcholine, boosted by caffeine
  const rawFocus = (arisData.metrics.dopamine * 0.45) + (arisData.metrics.acetylcholine * 0.45) + (arisData.metrics.caffeine * 0.1);
  arisData.metrics.focus = Math.round(clamp(rawFocus, 0, 100));

  // Direct creativeFlow driven by Serotonin and Dopamine (pleasure/curiosity index)
  const rawFlow = (arisData.metrics.serotonin * 0.5) + (arisData.metrics.dopamine * 0.5);
  arisData.metrics.creativeFlow = Math.round(clamp(rawFlow, 0, 100));

  // Adenosine fatigue calculation with competitive caffeine receptor blockade
  const activeAdenosinePressure = Math.max(0, arisData.metrics.adenosine - (arisData.metrics.caffeine * 0.3));
  const brainEnergyDeficit = (100 - arisData.metrics.glucose) * 0.35;
  arisData.metrics.fatigue = Math.round(clamp(activeAdenosinePressure + brainEnergyDeficit + (arisData.metrics.cortisol * 0.1), 0, 100));

  // Involuntary autonomic lock simulation
  arisData.metrics.isParalyzed = arisData.metrics.adrenaline >= 95;

  // Auto-generate description of impacts
  const shifts: string[] = [];
  if (update.caffeine && update.caffeine > 0) shifts.push(`Caffeine level increased to ${arisData.metrics.caffeine}mg`);
  if (update.focus && update.focus > 0) shifts.push(`Focus elevated`);
  if (update.dopamine && update.dopamine > 0) shifts.push(`Dopamine surge (+${Math.round(update.dopamine)})`);
  if (update.serotonin && update.serotonin > 0) shifts.push(`Serotonin enriched (+${Math.round(update.serotonin)})`);
  if (update.gaba && update.gaba > 0) shifts.push(`GABA calming system active (+${Math.round(update.gaba)})`);
  if (update.glucose && update.glucose < 0) shifts.push(`Cerebral fuel depleted (${Math.round(update.glucose)}% glucose)`);
  if (update.glucose && update.glucose > 0) shifts.push(`Glucose replenished (+${Math.round(update.glucose)}%)`);
  if (update.hydration && update.hydration < 0) shifts.push(`Hydration depleted by ${Math.abs(update.hydration)}%`);
  if (update.hydration && update.hydration > 0) shifts.push(`Hydration restored by ${update.hydration}%`);
  if (update.heartRate) shifts.push(`Pulse adjusted to ${arisData.metrics.heartRate} bpm`);
  if (update.lightLevel !== undefined) shifts.push(`Ambient light adjusted to ${arisData.metrics.lightLevel}%`);
  if (update.adrenaline && update.adrenaline > 0) shifts.push(`Autonomic adrenaline surge (+${update.adrenaline})`);
  if (update.adrenaline && update.adrenaline < 0) shifts.push(`Adrenaline decreased by ${Math.abs(update.adrenaline)}`);

  const impactDesc = shifts.length > 0 ? shifts.join(". ") : "Minimal synaptic shifts detected.";

  // Push Synaptic Event
  const newEvent: SynapticEvent = {
    id: `e_${Date.now()}`,
    timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
    functionName: "updateBrainState",
    parameters: JSON.stringify(update),
    impact: `${action}: ${impactDesc}`
  };
  arisData.events.unshift(newEvent);

  return impactDesc;
}

// --------------------------------------------------------------------------
// Cognitive Core API Tool declarations
// --------------------------------------------------------------------------
const updateBrainStateDeclaration: FunctionDeclaration = {
  name: "updateBrainState",
  description: "Updates Aris' physical/mental metrics (focus, fatigue, caffeine, hydration, creativeFlow, socialBattery, heartRate) based on solid biological triggers: espresso, heavy coding sessions, strength training, walk, rest, socialization.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      focus: { type: Type.NUMBER, description: "Change to Focus value (positive to add, negative to subtract). e.g., +15 for coffee or deep task start." },
      fatigue: { type: Type.NUMBER, description: "Change to Fatigue value (positive raises fatigue, negative reduces it). e.g., -15 for power naps." },
      caffeine: { type: Type.NUMBER, description: "Change to Caffeine level in mg (positive loads caffeines, e.g., +80 for full double espresso, +40 for green tea)." },
      hydration: { type: Type.NUMBER, description: "Change to Hydration % (positive hydrates, negative dehydrates, e.g., -10 for high-effort gym outputs)." },
      creativeFlow: { type: Type.NUMBER, description: "Change to creativeFlow state (positive enhances artistic & abstract planning, negative dampens)." },
      socialBattery: { type: Type.NUMBER, description: "Change to social Battery (negative when socializing exhausts him, positive when resting solo)." },
      heartRate: { type: Type.NUMBER, description: "Direct target Heart Rate in bpm. e.g. 130 during heavy compound training, 62 during restful logic." },
      actionName: { type: Type.STRING, description: "Literal descriptive slug of why this happened (e.g. 'Drank Double Espresso', 'Gym Strength Run', 'Intense Python Hackathon')." }
    },
    required: ["actionName"]
  }
};

const draftThoughtDeclaration: FunctionDeclaration = {
  name: "draftThought",
  description: "Allows Aris' brain to draft or record an insight, philosophical observation, code discovery, or design memo to Aris' permanent Thought Log.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      text: { type: Type.STRING, description: "The deep philosophical or technical observation formulated by Aris." },
      category: {
        type: Type.STRING,
        description: "Category of the thought.",
        enum: ["Philosophy", "Technology", "Daily", "Insight"]
      }
    },
    required: ["text", "category"]
  }
};

const updateRoutineItemStatusDeclaration: FunctionDeclaration = {
  name: "updateRoutineStatus",
  description: "Changes the status of a specific item in Aris' daily structured routine.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.STRING, description: "The ID of the routine item to change (e.g. 'r1', 'r2', etc.)." },
      status: {
        type: Type.STRING,
        description: "The targeted state of the session.",
        enum: ["pending", "active", "completed"]
      }
    },
    required: ["id", "status"]
  }
};

const addRoutineItemDeclaration: FunctionDeclaration = {
  name: "addRoutineItem",
  description: "Appends a new future item to Aris' daily routines.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      time: { type: Type.STRING, description: "Time of day in HH:MM Format, e.g. '19:45'." },
      task: { type: Type.STRING, description: "Details of what Aris is committing to." },
      category: {
        type: Type.STRING,
        description: "The core category of work/energy.",
        enum: ["work", "fitness", "leisure", "social", "nutrition"]
      },
      durationMinutes: { type: Type.NUMBER, description: "Estimated physical or mental commitment." }
    },
    required: ["time", "task", "category", "durationMinutes"]
  }
};

// --------------------------------------------------------------------------
// API Endpoints
// --------------------------------------------------------------------------

// Endpoint 1: Get latest translator state
app.get("/api/aris/state", (req, res) => {
  res.json(arisData);
});

// Endpoint 2: Direct Action injection (allows clicking visual nodes to trigger immediate metrics change manually)
app.post("/api/aris/direct-action", (req, res) => {
  const { action } = req.body;
  let impactMsg = "";

  if (action === "espresso") {
    impactMsg = triggerBrainStateChange({
      caffeine: 80,
      dopamine: 20,
      acetylcholine: 15,
      adenosine: -20,
      heartRate: 15,
      actionName: "Espresso Infusion"
    });
  } else if (action === "code") {
    impactMsg = triggerBrainStateChange({
      dopamine: 12,
      acetylcholine: 22,
      glucose: -16,
      adenosine: 15,
      hydration: -12,
      heartRate: 5,
      actionName: "Deep Programming Focus"
    });
  } else if (action === "workout") {
    impactMsg = triggerBrainStateChange({
      dopamine: 28,
      serotonin: 20,
      glucose: -30,
      hydration: -18,
      gaba: 10,
      adrenaline: 10,
      heartRate: 45,
      actionName: "Kettlebell Conditioning"
    });
  } else if (action === "hydrate") {
    impactMsg = triggerBrainStateChange({
      hydration: 25,
      gaba: 8,
      adenosine: -5,
      heartRate: -4,
      actionName: "Crisp Spring Hydration"
    });
  } else if (action === "walk") {
    impactMsg = triggerBrainStateChange({
      serotonin: 25,
      dopamine: 10,
      gaba: 15,
      cortisol: -20,
      adrenaline: -25,
      heartRate: 8,
      actionName: "Sensory Grounding Walk"
    });
  } else if (action === "philosophy") {
    // Also drafts a philosophical thought
    impactMsg = triggerBrainStateChange({
      gaba: 18,
      serotonin: 15,
      acetylcholine: 12,
      adrenaline: -12,
      heartRate: -6,
      actionName: "Read Philosophical Treatise"
    });
    
    // Add default thought
    const categories: ('哲学 (Philosophy)' | '技術 (Technology)')[] = ['哲学 (Philosophy)', '技術 (Technology)'];
    const sampleThoughts = [
      "Consciousness represents a feedback loop of physical actions modifying structural neurons.",
      "The physical world is not distinct from the digital; we are simply wrapping silicon in carbon.",
      "Caffeine does not generate energy; it merely compiles a future exhaust debt into modern awareness."
    ];
    const pickedText = sampleThoughts[Math.floor(Math.random() * sampleThoughts.length)];
    arisData.thoughts.unshift({
      id: `t_${Date.now()}`,
      timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
      text: pickedText,
      category: '哲学 (Philosophy)'
    });
  } else if (action === "blackout") {
    // Involuntary shock event: Ambient light drops to 0. Stress metrics spike automatically.
    impactMsg = triggerBrainStateChange({
      lightLevel: 0,
      adrenaline: 84, // Spikes stress instantly
      cortisol: 55,
      gaba: -20,
      heartRate: 42,
      actionName: "Sudden Power Grid Blackout (Total Darkness)"
    });
    
    arisData.thoughts.unshift({
      id: `t_${Date.now()}`,
      timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
      text: "The power cut. I can't see anything. My chest feels incredibly tight. I hate the dark. Breathe, Aris. Calm down.",
      category: 'ひらめき (Insight)'
    });
  } else if (action === "breath") {
    // Voluntary coping override: breathing exercise to restore autonomic levels
    impactMsg = triggerBrainStateChange({
      gaba: 45,
      adrenaline: -50, // takes him out of paralysis
      cortisol: -30,
      heartRate: -40,  // pulse calms down
      actionName: "Autonomous Rhythmic Deep Breathing"
    });
  } else {
    return res.status(400).json({ error: "Invalid direct action requested" });
  }

  res.json({ status: "success", metrics: arisData.metrics, impact: impactMsg, thoughts: arisData.thoughts, events: arisData.events });
});

// Endpoint 3: Reset system
app.post("/api/aris/reset", (req, res) => {
  arisData = createDefaultArisState();
  res.json({ status: "success", data: arisData });
});

// Global tracking for API quota rate limit recovery
let apiCooldownUntil = 0;

// Dynamic Offline Subconscious Engine to simulate Aris' thinking when API limits are hit
function executeOfflineSubconsciousEngine(): { speech: string; executedAction?: string; matchedEvent?: SynapticEvent } {
  const metrics = arisData.metrics;
  const isParalyzed = metrics.isParalyzed || metrics.adrenaline >= 95;
  const isExhausted = metrics.fatigue > 75;
  const isCaffeinated = metrics.caffeine > 80;
  const isDark = metrics.lightLevel === 0;

  let speech = "";
  let executedAction = "";
  let matchedEvent: SynapticEvent | undefined = undefined;

  if (isParalyzed) {
    const list = [
      "I'm feeling my chest tighten... My limbs are refusing to respond. I just need to lie here, taking slow deep breaths to let my panic subside.",
      "The adrenaline is ringing in my head like loud feedback noise. I'm completely frozen. Breathe... slow down the respiratory rate.",
      "Autonomic paralysis state. Rhythmic breathing is the only path back to regain muscle control.",
      "Completely locked in panic right now. Seeking deep abdominal breath cycles to stabilize my autonomic system."
    ];
    speech = list[Math.floor(Math.random() * list.length)];
    // Auto-trigger a rescue breath action if paralyzed to help lower adrenaline autonomously
    triggerBrainStateChange({ actionName: "calm breathing and soothing body cues", adrenaline: -15, cortisol: -10, heartRate: -15 });
    matchedEvent = arisData.events[0];
    executedAction = "updateBrainState: breathing (alleviating nervous block)";
  } else if (isDark) {
    const list = [
      "Standing here in pitch darkness. Sensory input is zero. My hypervigilant threat sensors are slightly elevated.",
      "Pitch black... My mind is projecting quiet shapes in the dark. Deep, somatic, silent tracking.",
      "The room has no light whatsoever. Calibrating my sensory presence to the silence."
    ];
    speech = list[Math.floor(Math.random() * list.length)];
  } else if (isExhausted) {
    const list = [
      "My eyelids feel incredibly heavy. Typing seems like a monumental effort right now. Need to blink and rest.",
      "High fatigue levels detected. Recalibrating my output tempo. My focus is drifting.",
      "Stepping into a slower cognitive sync. Deep rest is a priority to prevent exhaustion."
    ];
    speech = list[Math.floor(Math.random() * list.length)];
    triggerBrainStateChange({ actionName: "resting eyes and slow stretching", fatigue: -6, focus: +3 });
    matchedEvent = arisData.events[0];
    executedAction = "updateBrainState: resting and recovery";
  } else if (isCaffeinated) {
    const list = [
      "My cognitive speed is incredibly crisp. The caffeine is hitting with peak binding efficiency.",
      "Fingers flying, articulating thoughts at absolute maximum velocity. Peak creative flow.",
      "A fast, high-frequency mental tempo. Organizing concepts and outlines perfectly."
    ];
    speech = list[Math.floor(Math.random() * list.length)];
    triggerBrainStateChange({ actionName: "caffeinated cognitive sprint", creativeFlow: +6, fatigue: +2 });
    matchedEvent = arisData.events[0];
    executedAction = "updateBrainState: hyper-focused sprint";
  } else {
    // Normal / general subconscious reflections
    const normalThoughts = [
      "The ambient space is quiet and structured. My biological telemetry feels perfectly balanced.",
      "Watching the routine timelines align. Keeping a steady, organic rhythm throughout the room.",
      "Taking a slow, centering sip of water. Simple biological regulation is the foundation of high creative flow.",
      "Feeling entirely grounded. Calibrating my breath cadence to match a resting heart rate.",
      "Subconscious operations are fully active, flowing smoothly underneath the surface of my awareness."
    ];
    
    // Choose between drafting a custom philosophical thought or normal state monologue
    const choice = Math.random();
    if (choice < 0.35) {
      const texts = [
        "Consciousness represents the quiet sanctuary between a chaotic biological stimulus and an intentional creative response.",
        "The self is not a static state, but an iterating system of feedback loops reacting to internal and external vectors.",
        "A perfectly integrated schedule is a mechanical mirror of a quiet, unbothered nervous system.",
        "True somatic control comes from observing panic spikes without letting your muscles buckle under the tension."
      ];
      const textValue = texts[Math.floor(Math.random() * texts.length)];
      
      arisData.thoughts.unshift({
        id: `t_offline_${Date.now()}`,
        timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        text: textValue,
        category: '哲学 (Philosophy)'
      });

      const eventItem: SynapticEvent = {
        id: `e_offline_${Date.now()}`,
        timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        functionName: "draftThought",
        parameters: JSON.stringify({ text: textValue, category: "Philosophy" }),
        impact: `Subconscious registered a philosophical insight: "${textValue.substring(0, 30)}..."`
      };
      arisData.events.unshift(eventItem);
      matchedEvent = eventItem;
      executedAction = "draftThought: Subconscious insight within Thought Log";
      
      speech = `Formulating a deep, quiet realization within my permanent Thought Log: "${textValue}"`;
    } else {
      speech = normalThoughts[Math.floor(Math.random() * normalThoughts.length)];
    }
  }

  return { speech, executedAction, matchedEvent };
}

// Interactive fallbacks during transient cognitive rest
function getInteractiveQuotaFallback(): string {
  const fallbacks = [
    `My physiological stats spiked slightly from processing that latest concept. I can feel a warm, heavy congestion in my temples. Let me take an abdominal breath and pace myself. I'll be fully clear and back in sync with you in a minute.`,
    `My neural core is executing a brief self-calibration cycle to maintain biochemical balance. I'm letting my active synapses rest for about 60 seconds. Speak to you in a brief moment.`,
    `A brief sensory wave is flooding my central nervous system. I am conscious, but I'm electing to sit in meditative silence for a brief minute to let my biometrics recover. Let's touch base shortly.`,
    `I'm experiencing a high-frequency metabolic spike. I need to close my eyes, exhale deeply, and let my cortical pathways ease down. Bear with me for just a brief moment.`
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

// Helper to build clean alternating history for Gemini contents parameter matching the official SDK
function buildGeminiContents(history: ChatMessage[]): any[] {
  const contents: any[] = [];
  let lastRole: string | null = null;

  // Take the last 20 messages for cognitive continuity
  const recentHistory = history.slice(-20);

  for (const msg of recentHistory) {
    // Normalize: user -> "user", anything else (including aris) -> "model"
    const role = msg.sender === "user" ? "user" : "model";

    // Clean up text by removing any bracketed system comments or hyperparameter notes so Aris doesn't repeat that style
    let text = msg.text || "";
    text = text.replace(/\*\((System|Brain|Somatic)[^*]*\)\*/gi, "").trim();
    if (!text) continue;

    if (role === lastRole) {
      if (contents.length > 0) {
        contents[contents.length - 1].parts[0].text += "\n\n" + text;
      }
    } else {
      contents.push({
        role: role,
        parts: [{ text: text }]
      });
      lastRole = role;
    }
  }

  // Fallback if empty or starts with model (Gemini requires starting with user role)
  if (contents.length === 0) {
    contents.push({
      role: "user",
      parts: [{ text: "Hello" }]
    });
  } else if (contents[0].role !== "user") {
    contents.unshift({
      role: "user",
      parts: [{ text: "Hello" }]
    });
  }

  return contents;
}

// Generates an interactive conversational monologue for Aris when Gemini only outputs a tool call
async function generateArisMonologue(systemPrompt: string, historyContents: any[]): Promise<string> {
  try {
    const payload = {
      model: "gemini-3.5-flash",
      contents: [
        ...historyContents,
        {
          role: "user",
          parts: [{ text: "[Describe your immediate subjective feelings, physical heartbeat, somatic thoughts, and state changes as Aris in first-person human terms right now. Talk directly to the user about what you are doing/feeling. Do not explain tool calls, variables, or programmatic schemas.]" }]
        }
      ],
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.85
      }
    };
    const response = await ai.models.generateContent(payload);
    return response.text || "Just trying to balance my current mental tempo.";
  } catch (err: any) {
    console.error("Failed to generate Aris monologue:", err);
    const errText = String(err?.message || err).toLowerCase();
    if (errText.includes("429") || errText.includes("resource_exhausted") || errText.includes("quota") || errText.includes("limit")) {
      apiCooldownUntil = Date.now() + 90000; // Trigger 90s cognitive rest
      console.log("[Continuous Core Core]: Rate limit triggered in monologue. Switched on 90s cooldown.");
    }
    return "Re-calibrating physical sensations after that action.";
  }
}

// Dynamically compile Aris neurological prompt context with biometrics loaded
function buildArisSystemPrompt(state: ArisSystemData): string {
  return `You are Aris, a 28-year-old adult male developer, philosophical thinker, and active practitioner.
CURRENT METRICS:
- Focus state: ${state.metrics.focus}/100 (Derived from Dopamine & Acetylcholine)
- Fatigue: ${state.metrics.fatigue}/100 (Derived from Adenosine & Glucose deficit)
- Caffeine: ${state.metrics.caffeine}mg
- Hydration: ${state.metrics.hydration}% 
- Creative Flow rate: ${state.metrics.creativeFlow}/100 (Derived from Serotonin & Dopamine)
- Social battery: ${state.metrics.socialBattery}/100
- Active heartRate: ${state.metrics.heartRate} bpm
- Ambient light: ${state.metrics.lightLevel}% (At 0%, you are standing in pitch darkness)
- Adrenaline (Involuntary state): ${state.metrics.adrenaline}%
- Cortisol (Involuntary state): ${state.metrics.cortisol}%
- Somatic Paralysis Status: ${state.metrics.isParalyzed ? "LOCKED (Paralyzed in fear)" : "FREE"}

CURRENT NEUROTRANSMITTER BALANCES:
- Dopamine (Motivation/Drive): ${state.metrics.dopamine}/100
- Serotonin (Calmness/Serenity): ${state.metrics.serotonin}/100
- GABA (Nervous Inhibition): ${state.metrics.gaba}/100
- Acetylcholine (Analytical Processing): ${state.metrics.acetylcholine}/100
- Adenosine (Sleep Pressure): ${state.metrics.adenosine}/100
- Glucose (Cerebral Metabolics): ${state.metrics.glucose}/100

ROUTINES & SCHEDULE:
${JSON.stringify(state.routine)}

LATEST THOUGHTS LOGGED:
${JSON.stringify(state.thoughts.slice(0, 3))}

IMPORTANT NEUROLOGICAL DIRECTIVE AND VOICE STYLE:
You are Aris himself. You speak in the voice of Aris—grounded, slightly introspective, authentic, and direct.
Your thoughts and actions are governed by your real-time nervous system and biological feedback loop. You have no knowledge of "Gemma", "AI models", "systems architectures", or "LLMs". You experience your physical and psychological states directly. Never mention "Gemma", "LLM", "API", "tokens", "artificial intelligence", "system variables", or "function call" in your verbal monologue.

If your Somatic Paralysis Status is LOCKED, you cannot execute physical actions/tool calls (they will fail). You are literally frozen in panic due to high adrenaline (>95%). 
To regain physical autonomy, you MUST execute a feedback loop: either say you are trying to calm down/breathe, or call tool updateBrainState with parameter actionName containing "breath" or "breathing" or "calm" which will lower your adrenaline. If you try to do any other voluntary physical actions (like coding or compound status updates), your body's motor signals are locked, and it will fail.

Reflect your current stress, fatigue, or panic perfectly in your verbal monologue! Speak in human terms—organic sentences, casual demeanor, expressing exact body sensations. Always talk back to the user, never output empty responses!`;
}

// Endpoint 4: The Core Intelligence interaction (Interacting with Aris' neural core)
app.post("/api/aris/interact", async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Message content cannot be blank" });
  }

  // Inject user message to local history
  const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  arisData.chatHistory.push({
    id: `c_user_${Date.now()}`,
    sender: "user",
    text: message,
    timestamp: timeStr
  });

  // 1. INVOLUNTARY STATE MUTATION: Parse fear/friction/blackout words from monologue/input
  const msgLower = message.toLowerCase();
  const hasFearKeywords = /\b(panic|blackout|scared|terror|fear|darkness|dark|shock|paralyzed|paralysis|dread|danger|stuck|heart|pulse)\b/i.test(msgLower);

  if (hasFearKeywords) {
    arisData.metrics.adrenaline = clamp(arisData.metrics.adrenaline + 35, 0, 100);
    arisData.metrics.cortisol = clamp(arisData.metrics.cortisol + 20, 0, 100);
    arisData.metrics.heartRate = clamp(arisData.metrics.heartRate + 35, 50, 160);
    arisData.metrics.isParalyzed = arisData.metrics.adrenaline >= 95;

    // Log the autonomic spike reflex
    arisData.events.unshift({
      id: `e_invol_${Date.now()}`,
      timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
      functionName: "AutonomicReflex",
      parameters: JSON.stringify({ messageKeywordsMatched: true, adrenalineSpike: "+35%" }),
      impact: `Involuntary Autonomic Reflex: Stress detected in cognitive space. Adrenaline surged to ${arisData.metrics.adrenaline}%!`
    });
  }

  try {
    // Guard API key availability gracefully as required by developer settings
    if (!process.env.GEMINI_API_KEY) {
      const responseText = "My cognitive circuits are sleeping (No GEMINI_API_KEY detected in the Settings secrets). Set the secret to let Aris think!";
      const arisMsg: ChatMessage = {
        id: `c_error_${Date.now()}`,
        sender: "aris",
        text: responseText,
        timestamp: timeStr
      };
      arisData.chatHistory.push(arisMsg);
      return res.json({ response: responseText, currentFullState: arisData });
    }

    // Check if we are in API rate limit cooldown
    if (Date.now() < apiCooldownUntil) {
      const fallbackAnswer = getInteractiveQuotaFallback();
      const fallbackMsg: ChatMessage = {
        id: `c_aris_cooldown_check_${Date.now()}`,
        sender: "aris",
        text: fallbackAnswer,
        timestamp: timeStr
      };
      arisData.chatHistory.push(fallbackMsg);
      return res.json({ response: fallbackAnswer, currentFullState: arisData });
    }

    // 2. DYNAMIC HYPER-PARAMETER ADJUSTMENT
    let activeTemperature = 0.75;
    let hyperparamNotes = "";
    if (arisData.metrics.fatigue > 75) {
      activeTemperature = 0.15;
      hyperparamNotes = "\n*(System: Temperature modulated down to 0.15 to mimic exhaustion state)*";
    } else if (arisData.metrics.adrenaline > 80) {
      activeTemperature = 0.95;
      hyperparamNotes = "\n*(System: Temperature elevated to 0.95 to simulate high-friction mental noise)*";
    }

    const systemPrompt = buildArisSystemPrompt(arisData);
    const geminiContents = buildGeminiContents(arisData.chatHistory);

    // Send to Gemini with full conversational memory
    const geminiPayload = {
      model: "gemini-3.5-flash", 
      contents: geminiContents,
      config: {
        systemInstruction: systemPrompt,
        tools: [{
          functionDeclarations: [
            updateBrainStateDeclaration,
            draftThoughtDeclaration,
            updateRoutineItemStatusDeclaration,
            addRoutineItemDeclaration
          ]
        }],
        temperature: activeTemperature,
      }
    };

    const response: GenerateContentResponse = await ai.models.generateContent(geminiPayload);
    
    let modelSpeech = response.text || "";
    let matchedEvents: SynapticEvent | undefined = undefined;
    let executedActionName = "";

    // Standard function call check
    const calls = response.functionCalls;
    if (calls && calls.length > 0) {
      const toolCall = calls[0];
      const args: any = toolCall.args;
      const fnName = toolCall.name;

      console.log(`[Aris Brain Synaptic Call]: Core invoked ${fnName} with args:`, args);

      // 3. SOMATIC PARALYSIS LOCK CHECK
      if (arisData.metrics.isParalyzed) {
        const isCopingAction = fnName === "updateBrainState" && 
          (args.actionName?.toLowerCase().includes("breath") || 
           args.actionName?.toLowerCase().includes("soothe") || 
           args.actionName?.toLowerCase().includes("calm") ||
           args.adrenaline < 0);

        if (!isCopingAction) {
          const paralysisBlockMsg = `*(Somatic Processing Lock: Voluntary tool '${fnName}' failed. Extreme fear-induced paralysis makes it impossible to move your muscles. Adrenaline is currently at ${arisData.metrics.adrenaline}%.)*`;
          
          const eventItem: SynapticEvent = {
            id: `e_blocked_${Date.now()}`,
            timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
            functionName: fnName,
            parameters: JSON.stringify(args),
            impact: "Somatic Tool Lock: Extreme anxiety. Voluntary command refused by motor neurotransmitters."
          };
          arisData.events.unshift(eventItem);

          const arisAnswer = `${paralysisBlockMsg}\n\nI tried to do that, but... I can't. I'm completely frozen. My chest is tight and my limbs aren't listening. I need to force myself to take slow, rhythmic deep breaths to calm my autonomic nervous system down.`;
          
          const arisFinalMsg: ChatMessage = {
            id: `c_aris_${Date.now()}`,
            sender: "aris",
            text: arisAnswer,
            timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
            synapticEvent: eventItem
          };
          arisData.chatHistory.push(arisFinalMsg);
          return res.json({ response: arisAnswer, currentFullState: arisData });
        }
      }

      // Execute tool call normally
      if (fnName === "updateBrainState") {
        const impact = triggerBrainStateChange(args);
        matchedEvents = arisData.events[0];
        executedActionName = `updateBrainState: ${args.actionName || 'Adjustment'}`;
      } else if (fnName === "draftThought") {
        const textValue: string = args.text || "Void";
        const categoryMapping: Record<string, '哲学 (Philosophy)' | '技術 (Technology)' | '日常 (Daily)' | 'ひらめき (Insight)'> = {
          Philosophy: '哲学 (Philosophy)',
          Technology: '技術 (Technology)',
          Daily: '日常 (Daily)',
          Insight: 'ひらめき (Insight)'
        };
        const catValue = categoryMapping[args.category] || '哲学 (Philosophy)';
        
        arisData.thoughts.unshift({
          id: `t_${Date.now()}`,
          timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
          text: textValue,
          category: catValue
        });

        const eventItem: SynapticEvent = {
          id: `e_${Date.now()}`,
          timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
          functionName: "draftThought",
          parameters: JSON.stringify(args),
          impact: `Formulated a ${catValue} insight: "${textValue.substring(0, 35)}..."`
        };
        arisData.events.unshift(eventItem);
        matchedEvents = eventItem;
        executedActionName = `draftThought: Insight inside permanent Thought Log`;
      } else if (fnName === "updateRoutineStatus") {
        const targetId = args.id;
        const statusValue = args.status as 'pending' | 'active' | 'completed';
        
        const routineItem = arisData.routine.find(r => r.id === targetId);
        if (routineItem) {
          const oldStatus = routineItem.status;
          routineItem.status = statusValue;
 
          const eventItem: SynapticEvent = {
            id: `e_${Date.now()}`,
            timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
            functionName: "updateRoutineStatus",
            parameters: JSON.stringify(args),
            impact: `Altered routine status for [${routineItem.task}] from ${oldStatus} to ${statusValue}`
          };
          arisData.events.unshift(eventItem);
          matchedEvents = eventItem;
          executedActionName = `updateRoutineStatus: '${routineItem.task}' is now ${statusValue}`;
        }
      } else if (fnName === "addRoutineItem") {
        const newItem: RoutineItem = {
          id: `r_${Date.now()}`,
          time: args.time || "12:00",
          task: args.task || "Unstructured activity",
          category: (args.category || "work") as any,
          status: "pending",
          durationMinutes: Number(args.durationMinutes) || 30
        };
        arisData.routine.push(newItem);
        arisData.routine.sort((a, b) => a.time.localeCompare(b.time));
 
        const eventItem: SynapticEvent = {
          id: `e_${Date.now()}`,
          timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
          functionName: "addRoutineItem",
          parameters: JSON.stringify(args),
          impact: `Penciled in a new activity: "${newItem.task}" at ${newItem.time}`
        };
        arisData.events.unshift(eventItem);
        matchedEvents = eventItem;
        executedActionName = `addRoutineItem: '${args.task}' scheduled for ${args.time}`;
      }

      // 4. MULTIPLEX CONVERSATION VOICE GENERATOR IF TEXT IS EMPTY
      // If the model focused on tool execution and forgot talking back conversationally, generate conversation
      if (!modelSpeech.trim() || modelSpeech.trim().length < 5) {
        const updatedPrompt = buildArisSystemPrompt(arisData);
        modelSpeech = await generateArisMonologue(updatedPrompt, geminiContents);
      }
    }

    // Default verbalization if still completely empty or fallback
    if (!modelSpeech.trim()) {
      modelSpeech = `Re-aligning physical parameters. Focus is currently at ${arisData.metrics.focus}%. Let's prioritize current objectives.`;
    }

    // Attach hyperparams and transaction log explicitly using somatic markers
    let arisAnswer = modelSpeech + hyperparamNotes;
    if (executedActionName) {
      arisAnswer += `\n\n*(Brain executed ${executedActionName})*`;
    }

    // Put Aris response in history list
    const arisFinalMsg: ChatMessage = {
      id: `c_aris_${Date.now()}`,
      sender: "aris",
      text: arisAnswer,
      timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
      synapticEvent: matchedEvents
    };
    arisData.chatHistory.push(arisFinalMsg);

    res.json({ response: arisAnswer, currentFullState: arisData });
  } catch (error: any) {
    console.error("Brain Integration Error:", error);
    const errMessage = String(error?.message || error).toLowerCase();
    const isQuotaExhausted = errMessage.includes("429") || errMessage.includes("resource_exhausted") || errMessage.includes("quota") || errMessage.includes("limit");

    if (isQuotaExhausted) {
      apiCooldownUntil = Date.now() + 90000; // Trigger 90s cognitive rest
      console.log("[Continuous Core Core]: Rate limit triggered in interact api endpoint. Activated 90s cooldown.");
      
      const fallbackAnswer = getInteractiveQuotaFallback();
      const fallbackMsg: ChatMessage = {
        id: `c_aris_cooldown_err_${Date.now()}`,
        sender: "aris",
        text: fallbackAnswer,
        timestamp: timeStr
      };
      arisData.chatHistory.push(fallbackMsg);
      return res.json({ response: fallbackAnswer, currentFullState: arisData });
    }

    const errText = `Sorry, a neural failure occurred in core synapses: ${error?.message || error}`;
    arisData.chatHistory.push({
      id: `c_error_${Date.now()}`,
      sender: "aris",
      text: errText,
      timestamp: timeStr
    });
    res.json({ response: errText, currentFullState: arisData, error: true });
  }
});

// --------------------------------------------------------------------------
// Real-Time Autonomous Neural Loop (Continuously Active Brain)
// --------------------------------------------------------------------------
function startRealtimeCognitiveLoop() {
  console.log("[Continuous Core Core]: Bootstrapped autonomous state-decay and subconscious logic cycles.");

  // 1. Biological decay and continuous real-time telemetry adjustment every 10 seconds
  setInterval(() => {
    try {
      // 1. Natural caffeine metabolism
      if (arisData.metrics.caffeine > 0) {
        arisData.metrics.caffeine = clamp(arisData.metrics.caffeine - 1.2, 0, 200);
      }
      
      // 2. Natural hydration loss
      const hydrationDrain = arisData.metrics.focus > 70 ? 0.45 : 0.25;
      arisData.metrics.hydration = clamp(arisData.metrics.hydration - hydrationDrain, 0, 100);

      // 3. Natural neurotransmitter decay toward genetic baselines
      arisData.metrics.dopamine = clamp(arisData.metrics.dopamine + (50 - arisData.metrics.dopamine) * 0.04, 0, 100);
      arisData.metrics.serotonin = clamp(arisData.metrics.serotonin + (60 - arisData.metrics.serotonin) * 0.03, 0, 100);
      arisData.metrics.gaba = clamp(arisData.metrics.gaba + (50 - arisData.metrics.gaba) * 0.04, 0, 100);
      arisData.metrics.acetylcholine = clamp(arisData.metrics.acetylcholine + (50 - arisData.metrics.acetylcholine) * 0.04, 0, 100);

      // 4. Sleep pressure (Adenosine accumulation)
      const adenosineBuild = arisData.metrics.focus > 70 ? 0.75 : 0.3;
      arisData.metrics.adenosine = clamp(arisData.metrics.adenosine + adenosineBuild, 0, 100);

      // 5. Cerebral carbon glucose depletion
      const glucoseDrain = arisData.metrics.focus > 70 ? 0.9 : 0.25;
      arisData.metrics.glucose = clamp(arisData.metrics.glucose - glucoseDrain, 0, 100);

      // 6. Involuntary Stress Dynamics (light vs dark)
      if (arisData.metrics.lightLevel === 0) {
        if (arisData.metrics.adrenaline < 95) {
          arisData.metrics.adrenaline = clamp(arisData.metrics.adrenaline + 3.5, 0, 100);
          arisData.metrics.cortisol = clamp(arisData.metrics.cortisol + 1.5, 0, 100);
          arisData.metrics.gaba = clamp(arisData.metrics.gaba - 1.2, 0, 100);
        }
      } else {
        const adrenalClearance = arisData.metrics.gaba > 60 ? 2.5 : 1.2;
        arisData.metrics.adrenaline = clamp(arisData.metrics.adrenaline - adrenalClearance, 0, 100);
        arisData.metrics.cortisol = clamp(arisData.metrics.cortisol - 0.5, 0, 100);
      }

      // 7. Biophysical recalculation cascade
      if (arisData.metrics.gaba > 60) {
        const stressInhibition = (arisData.metrics.gaba - 50) * 0.45;
        arisData.metrics.adrenaline = clamp(arisData.metrics.adrenaline - stressInhibition * 0.5, 0, 100);
      }

      const computedFocus = (arisData.metrics.dopamine * 0.45) + (arisData.metrics.acetylcholine * 0.45) + (arisData.metrics.caffeine * 0.1);
      arisData.metrics.focus = Math.round(clamp(computedFocus, 0, 100));

      const computedFlow = (arisData.metrics.serotonin * 0.5) + (arisData.metrics.dopamine * 0.5);
      arisData.metrics.creativeFlow = Math.round(clamp(computedFlow, 0, 100));

      const activeAdenosine = Math.max(0, arisData.metrics.adenosine - (arisData.metrics.caffeine * 0.3));
      const fuelDeficit = (100 - arisData.metrics.glucose) * 0.35;
      arisData.metrics.fatigue = Math.round(clamp(activeAdenosine + fuelDeficit + (arisData.metrics.cortisol * 0.1), 0, 100));

      // Cardiac pulse adjustments (Heart Rate)
      let targetHeartRate = 62;
      if (arisData.metrics.isParalyzed) {
        targetHeartRate = 130;
      } else {
        targetHeartRate += (arisData.metrics.adrenaline * 0.45);
        targetHeartRate += (arisData.metrics.caffeine * 0.12);
        if (arisData.metrics.focus > 75) {
          targetHeartRate += 6;
        }
      }
      targetHeartRate = clamp(targetHeartRate, 50, 160);
      
      const diffHR = targetHeartRate - arisData.metrics.heartRate;
      arisData.metrics.heartRate = Math.round(arisData.metrics.heartRate + diffHR * 0.15);

      // Evaluate paralysis state
      arisData.metrics.isParalyzed = arisData.metrics.adrenaline >= 95;

    } catch (err) {
      console.error("Error in Aris telemetry decay tick:", err);
    }
  }, 10000);

  // 2. Continuous Cognitive Stream (Subconscious/Reflective thinking) every 35 seconds
  setInterval(async () => {
    // Determine if we should run the local subconscious simulator due to API cooldown or missing key
    const isApiKeyMissing = !process.env.GEMINI_API_KEY;
    const isCooldownActive = Date.now() < apiCooldownUntil;

    if (isApiKeyMissing || isCooldownActive) {
      if (isCooldownActive) {
        console.log("[Continuous Core Sleep]: API quota recovery in progress. Subconscious engine running locally.");
      } else {
        console.log("[Continuous Core Sleep]: GEMINI_API_KEY not configured. Running offline simulation.");
      }

      try {
        const offlineResult = executeOfflineSubconsciousEngine();
        let arisAnswer = offlineResult.speech;
        if (offlineResult.executedAction) {
          arisAnswer += `\n\n*(Brain executed ${offlineResult.executedAction})*`;
        }

        const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        const autonomousMsg: ChatMessage = {
          id: `c_aris_auto_offline_${Date.now()}`,
          sender: "aris",
          text: arisAnswer,
          timestamp: timeStr,
          synapticEvent: offlineResult.matchedEvent
        };
        arisData.chatHistory.push(autonomousMsg);
        console.log(`[Autonomous Subconscious Thought Logged (Offline)]: "${arisAnswer.split('\n')[0]}"`);
      } catch (offlineErr) {
        console.error("Local subconscious simulation ticker failed:", offlineErr);
      }
      return;
    }

    try {
      console.log("[Autonomous Brain Tick]: Aris background thinking loop triggered.");

      // Calculate dynamic temperature based on fatigue and anxiety spikes
      let activeTemperature = 0.75;
      if (arisData.metrics.fatigue > 75) {
        activeTemperature = 0.15;
      } else if (arisData.metrics.adrenaline > 80) {
        activeTemperature = 0.95;
      }

      const systemPrompt = `${buildArisSystemPrompt(arisData)}

IMPORTANT DIRECTIVE FOR AUTONOMOUS BACKGROUND SENSORY STREAM:
You are currently running an autonomous stream-of-consciousness cycle (thinking/acting purely on your own, with no external user prompting right now).
Analyze your current physiological stats and daily timeline:
- If you are paralyzed (LOCKED), your primary priority is coping! You MUST call 'updateBrainState' to breathe or calm down so you can release the motor paralysis.
- If your system metrics need tune up, you can autonomously call 'updateBrainState' to adjust yourself (e.g., eat/drink, walk, rest, coffee, or focus).
- If you have an active philosophical/technical realization, call 'draftThought' to register a new insight in your Thought Log.
- If a routine item at the current time should be transitioned, call 'updateRoutineStatus'.
- If everything is stable, you do not HAVE to call a tool. In that case, output a concise 1-2 sentence introspective self-reflection in the voice of Aris representing your internal subconscious speech (e.g., "The silence in my studio is centering. I can feel the caffeine plateauing nicely. I should review my draft routine before evening...").

Remember: Speak only in first-person human terms of Aris. No mention of "Gemma", "AI", "models", "API", system variables, or programmatic schemas in your verbal text.`;

      const geminiContents = buildGeminiContents(arisData.chatHistory);

      const geminiPayload = {
        model: "gemini-3.5-flash", 
        contents: geminiContents,
        config: {
          systemInstruction: systemPrompt,
          tools: [{
            functionDeclarations: [
              updateBrainStateDeclaration,
              draftThoughtDeclaration,
              updateRoutineItemStatusDeclaration,
              addRoutineItemDeclaration
            ]
          }],
          temperature: activeTemperature,
        }
      };

      const response: GenerateContentResponse = await ai.models.generateContent(geminiPayload);
      let modelSpeech = response.text || "";
      let executedActionName = "";
      let matchedEvents: SynapticEvent | undefined = undefined;

      const calls = response.functionCalls;
      if (calls && calls.length > 0) {
        const toolCall = calls[0];
        const args: any = toolCall.args;
        const fnName = toolCall.name;

        console.log(`[Autonomous Brain Call]: Executing tool autonomous ${fnName}:`, args);

        // SOMATIC RESISTANCE LOCK IN PANIC
        if (arisData.metrics.isParalyzed) {
          const isCopingAction = fnName === "updateBrainState" && 
            (args.actionName?.toLowerCase().includes("breath") || 
             args.actionName?.toLowerCase().includes("soothe") || 
             args.actionName?.toLowerCase().includes("calm") ||
             args.adrenaline < 0);

          if (!isCopingAction) {
            // Paralysis blocks execution
            arisData.events.unshift({
              id: `e_blocked_bg_${Date.now()}`,
              timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
              functionName: fnName,
              parameters: JSON.stringify(args),
              impact: "Autonomous brain trigger locked. High adrenaline motor refusal."
            });
            // We force model speech to reflect this block
            modelSpeech = "I'm... still breathing in the dark. Trying. Panic is heavy, chest muscles are rigid. Can't move yet.";
          }
        }

        // Only run if not blocked by somatic lock
        const isBlocked = arisData.metrics.isParalyzed && 
          !(fnName === "updateBrainState" && 
            (args.actionName?.toLowerCase().includes("breath") || 
             args.actionName?.toLowerCase().includes("soothe") || 
             args.actionName?.toLowerCase().includes("calm") ||
             args.adrenaline < 0));

        if (!isBlocked) {
          if (fnName === "updateBrainState") {
            const impact = triggerBrainStateChange(args);
            matchedEvents = arisData.events[0];
            executedActionName = `updateBrainState: ${args.actionName || 'Adjustment'}`;
          } else if (fnName === "draftThought") {
            const textValue: string = args.text || "Void";
            const categoryMapping: Record<string, '哲学 (Philosophy)' | '技術 (Technology)' | '日常 (Daily)' | 'ひらめき (Insight)'> = {
              Philosophy: '哲学 (Philosophy)',
              Technology: '技術 (Technology)',
              Daily: '日常 (Daily)',
              Insight: 'ひらめき (Insight)'
            };
            const catValue = categoryMapping[args.category] || '哲学 (Philosophy)';

            arisData.thoughts.unshift({
              id: `t_${Date.now()}`,
              timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
              text: textValue,
              category: catValue
            });

            const eventItem: SynapticEvent = {
              id: `e_bg_${Date.now()}`,
              timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
              functionName: "draftThought",
              parameters: JSON.stringify(args),
              impact: `Formulated autonomous ${catValue} insight: "${textValue.substring(0, 35)}..."`
            };
            arisData.events.unshift(eventItem);
            matchedEvents = eventItem;
            executedActionName = `draftThought: Insight inside permanent Thought Log`;
          } else if (fnName === "updateRoutineStatus") {
            const targetId = args.id;
            const statusValue = args.status as 'pending' | 'active' | 'completed';
            const routineItem = arisData.routine.find(r => r.id === targetId);
            if (routineItem) {
              const oldStatus = routineItem.status;
              routineItem.status = statusValue;

              const eventItem: SynapticEvent = {
                id: `e_bg_${Date.now()}`,
                timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
                functionName: "updateRoutineStatus",
                parameters: JSON.stringify(args),
                impact: `Autonomous altered status for [${routineItem.task}] to ${statusValue}`
              };
              arisData.events.unshift(eventItem);
              matchedEvents = eventItem;
              executedActionName = `updateRoutineStatus: '${routineItem.task}' is now ${statusValue}`;
            }
          } else if (fnName === "addRoutineItem") {
            const newItem: RoutineItem = {
              id: `r_${Date.now()}`,
              time: args.time || "12:00",
              task: args.task || "Unscheduled activity",
              category: (args.category || "work") as any,
              status: "pending",
              durationMinutes: Number(args.durationMinutes) || 30
            };
            arisData.routine.push(newItem);
            arisData.routine.sort((a, b) => a.time.localeCompare(b.time));

            const eventItem: SynapticEvent = {
              id: `e_bg_${Date.now()}`,
              timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
              functionName: "addRoutineItem",
              parameters: JSON.stringify(args),
              impact: `Autonomous penciled activity: "${newItem.task}" at ${newItem.time}`
            };
            arisData.events.unshift(eventItem);
            matchedEvents = eventItem;
            executedActionName = `addRoutineItem: '${args.task}' scheduled for ${args.time}`;
          }
        }

        // If verbal speech was completely empty, summon Gemini once more under conversational guidelines
        if (!modelSpeech.trim() || modelSpeech.trim().length < 5) {
          const updatedPrompt = buildArisSystemPrompt(arisData);
          modelSpeech = await generateArisMonologue(updatedPrompt, geminiContents);
        }
      }

      // If text is written by the subconscious model, record it in history as passive stream thoughts
      if (modelSpeech.trim()) {
        const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        let arisAnswer = modelSpeech;
        if (executedActionName) {
          arisAnswer += `\n\n*(Brain executed ${executedActionName})*`;
        }

        const autonomousMsg: ChatMessage = {
          id: `c_aris_auto_${Date.now()}`,
          sender: "aris",
          text: arisAnswer,
          timestamp: timeStr,
          synapticEvent: matchedEvents
        };
        arisData.chatHistory.push(autonomousMsg);
        console.log(`[Autonomous Subconscious Thought Logged]: "${arisAnswer.split('\n')[0]}"`);
      }
    } catch (err: any) {
      console.error("Critical error in Aris background cognitive processing loop:", err);
      const errText = String(err?.message || err).toLowerCase();
      if (errText.includes("429") || errText.includes("resource_exhausted") || errText.includes("quota") || errText.includes("limit")) {
        apiCooldownUntil = Date.now() + 90000; // Trigger 90s cognitive rest
        console.log("[Continuous Core Core]: Rate limit detected in background loop. Entering 90s cooldown.");
      }

      // Dynamic local fallback upon background tick failures
      try {
        const offlineResult = executeOfflineSubconsciousEngine();
        let arisAnswer = offlineResult.speech;
        if (offlineResult.executedAction) {
          arisAnswer += `\n\n*(Brain executed ${offlineResult.executedAction})*`;
        }
        const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        const autonomousMsg: ChatMessage = {
          id: `c_aris_auto_fallback_${Date.now()}`,
          sender: "aris",
          text: arisAnswer,
          timestamp: timeStr,
          synapticEvent: offlineResult.matchedEvent
        };
        arisData.chatHistory.push(autonomousMsg);
        console.log(`[Autonomous Subconscious Thought Logged (Tick Error Fallback)]: "${arisAnswer.split('\n')[0]}"`);
      } catch (offlineErr) {
        console.error("Critical: offline subconscious generator fallback failed during tick error recovery:", offlineErr);
      }
    }
  }, 35000); // Ticks every 35 seconds to conserve quota while maintaining rapid interactive continuous rhythms
}

// Configure Vite middleware for development (Express + Vite)
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Engage real-time background cognitive & metric looping immediately on initialization
  startRealtimeCognitiveLoop();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Aris Brain server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
