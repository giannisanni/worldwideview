"use client";

/**
 * iOS-style pill toggle that hops to the companion app.
 *
 * We're on the WWV (World) side here, so the knob sits on the RIGHT and
 * the label on the left shows the destination ("HOME"). Clicking the pill
 * navigates to the Mentat React frontend.
 *
 * Destination URL comes from NEXT_PUBLIC_MENTAT_HOME_URL.
 */

import "./MentatHomeWorldToggle.css";

const HOME_URL =
    process.env.NEXT_PUBLIC_MENTAT_HOME_URL ?? "http://localhost:63682";

export function MentatHomeWorldToggle() {
    return (
        <a
          href={HOME_URL}
          role="switch"
          aria-checked="true"
          aria-label="Switch to Home view"
          className="mentat-toggle"
        >
          <span className="mentat-toggle__label">Home</span>
          <span className="mentat-toggle__knob" aria-hidden="true" />
        </a>
    );
}
