import type { Expected } from "./expected.ts";
import { inView, plainText } from "./dom.ts";

// The filter lists the dataset's chains in order, with the first chosen and nothing hiding it.
export function checkFilter(
  page: string,
  document: Document,
  expected: Expected,
  problems: string[],
) {
  if (expected.filter.length === 0) return;
  const filter = document.querySelector('.dashboard [data-section="chain-filter"]');
  if (!filter || !inView(filter)) {
    problems.push(`${page}: the chain filter isn't in view`);
    return;
  }
  const radios = [
    ...filter.querySelectorAll<HTMLInputElement>('input[type="radio"][name="chain"]'),
  ];
  const said = radios.map((input) => `${input.value}=${plainText(input.closest("label"))}`);
  const want = expected.filter.map(({ value, label }) => `${value}=${label}`);
  if (said.join() !== want.join()) {
    problems.push(
      `${page}: the chain filter lists ${said.join()}, not the dataset's ${want.join()}`,
    );
  }
  const chosen = radios.filter((input) => input.hasAttribute("checked"));
  if (chosen.length !== 1 || chosen[0] !== radios[0]) {
    problems.push(`${page}: the chain filter doesn't start on its first option`);
  }
}
