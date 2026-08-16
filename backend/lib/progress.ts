// Minimal structural view of a flow step's progress handle (the `progress`
// arg passed to step functions — see @teamkeel/functions-runtime ProgressHandle).
// Helpers accept this so they can report per-item progress without importing
// flow-runtime types, and tests can pass a fake. Reporting only — never drive
// control flow off it, and keep calls side-effect-free so step replay is stable.
export interface ProgressReporter {
    set(patch: {
        message?: string;
        current?: number;
        total?: number;
        unit?: string;
        counter?: 'count' | 'percent' | 'none';
        data?: Record<string, unknown>;
    }): void;
    increment(n?: number): void;
    log(message: string): void;
}
