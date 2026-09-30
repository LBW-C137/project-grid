// Shared polling helper for the desktop smoke tests.
// CI runners are much slower than a workstation (six PowerShell processes on two cores), so CI
// stretches every timeout with PROJECT_GRID_TEST_TIMEOUT_SCALE instead of each test guessing its own.
export const timeoutScale = Math.max(1, Number(process.env.PROJECT_GRID_TEST_TIMEOUT_SCALE) || 1);

export async function waitFor(check, label, timeout = 25000) {
  const until = Date.now() + timeout * timeoutScale;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${label}`);
}
