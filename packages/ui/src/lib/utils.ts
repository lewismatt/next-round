// SPDX-License-Identifier: MIT
// Derived from shadcn/ui; see third_party/shadcn-LICENSE.txt.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
