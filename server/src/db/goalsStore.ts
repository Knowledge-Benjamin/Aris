import { getDatabasePool } from "./db";

const pool = getDatabasePool();

export interface UserState {
  userId: number;
  state: any;
  coachPersona: string;
}

export interface Goal {
  id: number;
  userId: number;
  title: string;
  description?: string;
  status: string;
  targetDate?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface GoalMilestone {
  id: number;
  goalId: number;
  title: string;
  status: string;
  dueDate?: Date;
}

export interface DailyTask {
  id: number;
  userId: number;
  goalId?: number;
  title: string;
  description?: string;
  calendarEventId?: string;
  startTime?: Date;
  endTime?: Date;
  status: string;
}

export const goalsStore = {
  async getUserState(userId: number): Promise<UserState> {
    const res = await pool.query(`SELECT state, coach_persona FROM user_state WHERE user_id = $1`, [userId]);
    if (res.rows.length === 0) {
      return { userId, state: {}, coachPersona: 'encouraging' };
    }
    return {
      userId,
      state: res.rows[0].state,
      coachPersona: res.rows[0].coach_persona
    };
  },

  async updateUserState(userId: number, stateUpdates: any): Promise<UserState> {
    const current = await this.getUserState(userId);
    const newState = { ...current.state, ...stateUpdates };
    
    await pool.query(`
      INSERT INTO user_state (user_id, state, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id) DO UPDATE SET state = $2, updated_at = NOW()
    `, [userId, JSON.stringify(newState)]);
    
    return { ...current, state: newState };
  },

  async updateCoachPersona(userId: number, persona: string): Promise<void> {
    await pool.query(`
      INSERT INTO user_state (user_id, coach_persona, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id) DO UPDATE SET coach_persona = $2, updated_at = NOW()
    `, [userId, persona]);
  },

  async createGoal(userId: number, title: string, description?: string, targetDate?: Date): Promise<Goal> {
    const res = await pool.query(`
      INSERT INTO goals (user_id, title, description, target_date)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [userId, title, description, targetDate]);
    const row = res.rows[0];
    return {
      id: row.id, userId: row.user_id, title: row.title, description: row.description,
      status: row.status, targetDate: row.target_date, createdAt: row.created_at, updatedAt: row.updated_at
    };
  },

  async getActiveGoals(userId: number): Promise<Goal[]> {
    const res = await pool.query(`
      SELECT * FROM goals WHERE user_id = $1 AND status = 'active'
    `, [userId]);
    return res.rows.map((row: any) => ({
      id: row.id, userId: row.user_id, title: row.title, description: row.description,
      status: row.status, targetDate: row.target_date, createdAt: row.created_at, updatedAt: row.updated_at
    }));
  },

  async addDailyTask(userId: number, title: string, description?: string, goalId?: number, startTime?: Date, endTime?: Date, calendarEventId?: string): Promise<DailyTask> {
    const res = await pool.query(`
      INSERT INTO daily_tasks (user_id, goal_id, title, description, start_time, end_time, calendar_event_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [userId, goalId, title, description, startTime, endTime, calendarEventId]);
    const row = res.rows[0];
    return {
      id: row.id, userId: row.user_id, goalId: row.goal_id, title: row.title, description: row.description,
      calendarEventId: row.calendar_event_id, startTime: row.start_time, endTime: row.end_time, status: row.status
    };
  },

  async getPendingTasks(userId: number): Promise<DailyTask[]> {
    const res = await pool.query(`
      SELECT * FROM daily_tasks WHERE user_id = $1 AND status = 'pending'
    `, [userId]);
    return res.rows.map((row: any) => ({
      id: row.id, userId: row.user_id, goalId: row.goal_id, title: row.title, description: row.description,
      calendarEventId: row.calendar_event_id, startTime: row.start_time, endTime: row.end_time, status: row.status
    }));
  },
  
  async markTaskStatus(taskId: number, status: string): Promise<void> {
    await pool.query(`UPDATE daily_tasks SET status = $1, updated_at = NOW() WHERE id = $2`, [status, taskId]);
  }
};
