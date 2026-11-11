import { Caveat, Homemade_Apple, Instrument_Sans, Mrs_Saint_Delafield } from "next/font/google";

/** One family for the whole interface; headings use its condensed width axis. */
export const instrument = Instrument_Sans({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-instrument",
  display: "swap",
});

// Handwriting faces offered when a signer types their name instead of drawing it.
const caveat = Caveat({ subsets: ["latin"], weight: "500", display: "swap" });
const homemade = Homemade_Apple({ subsets: ["latin"], weight: "400", display: "swap" });
const delafield = Mrs_Saint_Delafield({ subsets: ["latin"], weight: "400", display: "swap" });

export const SIGNATURE_FACES = [
  { id: "delafield", label: "Formal", family: delafield.style.fontFamily, className: delafield.className, scale: 1.5 },
  { id: "caveat", label: "Casual", family: caveat.style.fontFamily, className: caveat.className, scale: 1.05 },
  { id: "homemade", label: "Looped", family: homemade.style.fontFamily, className: homemade.className, scale: 0.72 },
];
