"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Send } from "lucide-react";
import { useEffect, useState } from "react";

type Props = {
  visible: boolean;
  playerName: string;
  telegramUsername: string;
  message: string;
};

export function TelegramBubble({ visible, playerName, telegramUsername, message }: Props) {
  const [showTyping, setShowTyping] = useState(true);

  useEffect(() => {
    if (visible) {
      setShowTyping(true);
      const t = setTimeout(() => setShowTyping(false), 700);
      return () => clearTimeout(t);
    }
  }, [visible]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, x: 40, scale: 0.9 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: 40, scale: 0.9 }}
          transition={{ type: "spring", damping: 20, stiffness: 200 }}
          className="w-[280px] rounded-xl border bg-gradient-to-br from-[#229ED9]/5 to-[#229ED9]/10 p-3 shadow-lg"
        >
          <div className="flex items-center gap-2 border-b border-[#229ED9]/20 pb-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[#229ED9] text-white">
              <Send className="h-3 w-3" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold truncate">Telegram → {playerName}</div>
              <div className="text-[10px] text-muted-foreground truncate">
                {telegramUsername}
              </div>
            </div>
          </div>

          <div className="mt-2 min-h-[40px]">
            <AnimatePresence mode="wait">
              {showTyping ? (
                <motion.div
                  key="typing"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-1 rounded-lg bg-[#229ED9]/10 px-3 py-2 w-fit"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-[#229ED9] animate-pulse" style={{ animationDelay: "0ms" }} />
                  <span className="h-1.5 w-1.5 rounded-full bg-[#229ED9] animate-pulse" style={{ animationDelay: "150ms" }} />
                  <span className="h-1.5 w-1.5 rounded-full bg-[#229ED9] animate-pulse" style={{ animationDelay: "300ms" }} />
                </motion.div>
              ) : (
                <motion.div
                  key="msg"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="rounded-lg bg-[#229ED9] px-3 py-1.5 text-[12px] text-white"
                >
                  {message}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
