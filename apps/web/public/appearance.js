// SPDX-License-Identifier: Apache-2.0
/* global document, localStorage, matchMedia */
// Apply the saved appearance before styles paint; storage may be unavailable.
(() => {
  let theme;
  try {
    theme = localStorage.getItem("next-round:appearance:v1");
  } catch {
    // Fall back to the system preference when storage is disabled.
  }
  if (theme !== "light" && theme !== "dark") {
    theme = matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
})();
