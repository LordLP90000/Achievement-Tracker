import { performance } from 'node:perf_hooks';
import type { Logger } from 'pino';
import { jobErrorCode, type ScheduledJob } from '../../platform/jobs/scheduler.ts';
import { nextLocalMidnight } from '../../platform/time/time-zones.ts';
import { syncAchievement, withGoals, type GoalDependencies } from './engine.ts';
import { changingAchievements, dueUsers, recordEvaluation } from './evaluation-repository.ts';

/**
 * The daily goal evaluation (A-20, A-21, R-QST-04, R-GMB-03): after each user's local midnight, the goal engine looks
 * at their achievements that time alone can change, as a request would — a missed period resets the habit, a gamble
 * whose target date has passed is lost — even if the user never opens the app. One user at a time, each in their own
 * transaction under their goal lock (worker role, their context set, so only their rows can change).
 */

export const GOAL_EVALUATION_JOB = 'evaluate_goals';
/** Every scheduler tick: a run takes a few users, and the next runs catch up. */
export const GOAL_EVALUATION_INTERVAL_MS = 60_000;

export interface GoalEvaluationOptions {
  /** Users per run (default 50). */
  readonly batchSize?: number;
  /**
   * After this much wall-clock time a run starts no other user (default 5 s): the scheduler's own transaction waits
   * meanwhile and must not idle past its timeout (10 s).
   */
  readonly budgetMs?: number;
}

export interface GoalJobDependencies extends GoalDependencies {
  readonly logger: Logger;
}

async function evaluate(deps: GoalDependencies, userId: string): Promise<void> {
  await withGoals(deps, userId, async (scope) => {
    for (const achievementId of await changingAchievements(scope.tx, userId)) {
      await syncAchievement(scope, achievementId);
    }
    await recordEvaluation(scope.tx, userId, scope.today, nextLocalMidnight(scope.now, scope.timeZone));
  });
}

export function goalJobs(deps: GoalJobDependencies, options: GoalEvaluationOptions = {}): ScheduledJob[] {
  const batchSize = options.batchSize ?? 50;
  const budgetMs = options.budgetMs ?? 5_000;
  return [
    {
      name: GOAL_EVALUATION_JOB,
      intervalMs: GOAL_EVALUATION_INTERVAL_MS,
      async run(tx, now) {
        const started = performance.now();
        let evaluated = 0;
        for (const user of await dueUsers(tx, now, batchSize)) {
          try {
            await evaluate(deps, user.userId);
            evaluated += 1;
          } catch (error) {
            // The user stays due and is tried again by the next run; no user data in the log (R-LOG-02).
            deps.logger.error({ job: GOAL_EVALUATION_JOB, error_code: jobErrorCode(error) }, 'goal evaluation failed');
          }
          if (performance.now() - started >= budgetMs) break;
        }
        return evaluated;
      },
    },
  ];
}
