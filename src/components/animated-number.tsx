"use client";

import { useEffect, useState } from "react";
import { motion, useMotionValue, useTransform, animate } from "framer-motion";

export function AnimatedNumber({
  value,
  durationMs = 1200,
  prefix = "",
  decimals = 2,
}: {
  value: number;
  durationMs?: number;
  prefix?: string;
  decimals?: number;
}) {
  const mv = useMotionValue(value);
  const rounded = useTransform(mv, (v) =>
    `${prefix}${v.toLocaleString("en-MY", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })}`,
  );
  const [display, setDisplay] = useState<string>(
    `${prefix}${value.toLocaleString("en-MY", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })}`,
  );

  useEffect(() => {
    const controls = animate(mv, value, { duration: durationMs / 1000, ease: "easeOut" });
    const unsub = rounded.on("change", (v) => setDisplay(v));
    return () => {
      controls.stop();
      unsub();
    };
  }, [value, durationMs, mv, rounded]);

  return <motion.span>{display}</motion.span>;
}
