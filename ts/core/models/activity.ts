// models.py: the activity of a day (Workout, WeekProgress, DayActivity) as the API shows it.


export type WorkoutSource = 'manual' | 'health' | 'yazio' | 'demo';

export interface Workout {
  id: number; day: string; started_at: number | null; kind: string; name: string; minutes: number; kcal: number;
  kcal_estimated: boolean; distance_m: number | null; steps: number | null; note: string | null; source: WorkoutSource;
}

export interface WeekProgress { goal: number; days: boolean[]; done: number; streak: number }

export interface DayActivity {
  steps: number | null; steps_goal: number; active_kcal: number | null; distance_m: number | null; source: WorkoutSource | null;
  bonus_kcal: number; workouts: Workout[]; week: WeekProgress | null;
}
