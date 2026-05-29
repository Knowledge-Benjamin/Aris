export interface BrainMetrics {
  focus: number;       // 0 - 100
  fatigue: number;     // 0 - 100
  caffeine: number;    // mg (0 - 200)
  hydration: number;   // % (0 - 100)
  creativeFlow: number; // 0 - 100
  socialBattery: number; // 0 - 100
  heartRate: number;   // bpm
  lightLevel: number;  // 0 - 100 (involuntary sensor input)
  adrenaline: number;  // 0 - 100 (autonomic flight-or-fight)
  cortisol: number;    // 0 - 100 (chronic physical/cognitive stress)
  isParalyzed: boolean; // somatic lock representing extreme autonomic fear (>95% stress/adrenaline)

  // Advanced neurochemical simulation metrics
  dopamine: number;     // Motivation & Reward (0-100)
  serotonin: number;    // Mood Regulation & Calm (0-100)
  gaba: number;         // Synaptic Inhibition & Relaxation (0-100)
  acetylcholine: number;// Learning, Memory & Attention (0-100)
  adenosine: number;    // Sleep Pressure (0-100)
  glucose: number;      // Cerebral Metabolic Energy (0-100)
}

export interface RoutineItem {
  id: string;
  time: string;
  task: string;
  category: 'work' | 'fitness' | 'leisure' | 'social' | 'nutrition';
  status: 'pending' | 'active' | 'completed';
  durationMinutes: number;
}

export interface ThoughtLog {
  id: string;
  timestamp: string;
  text: string;
  category: '哲学 (Philosophy)' | '技術 (Technology)' | '日常 (Daily)' | 'ひらめき (Insight)';
}

export interface SynapticEvent {
  id: string;
  timestamp: string;
  functionName: string;
  parameters: string;
  impact: string;
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'aris';
  text: string;
  timestamp: string;
  synapticEvent?: SynapticEvent;
}

export interface ArisSystemData {
  metrics: BrainMetrics;
  routine: RoutineItem[];
  thoughts: ThoughtLog[];
  events: SynapticEvent[];
  chatHistory: ChatMessage[];
}
