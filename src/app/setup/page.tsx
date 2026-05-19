"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createAdminAccount } from "./actions";
import styles from "./setup.module.css";

export default function SetupPage() {
    const router = useRouter();
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setError("");
        setLoading(true);

        const formData = new FormData(e.currentTarget);
        const result = await createAdminAccount(formData);

        if (result.success) {
            router.push("/login");
        } else {
            setError(result.error ?? "Setup failed.");
            setLoading(false);
        }
    }

    return (
      <div className={styles.container}>
        <div className={styles.card}>
          <div className={styles.logo} aria-label="Mentat">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <path d="M12 7l5 5-5 5-5-5z"/>
            </svg>
          </div>
          <h1 className={styles.title}>Welcome to Mentat</h1>
          <p className={styles.subtitle}>Create your admin account to get started</p>

          <form onSubmit={handleSubmit} className={styles.form}>
            <label className={styles.label} htmlFor="name">
              Display Name
              <input
                id="name"
                name="name"
                type="text"
                required
                className={styles.input}
                placeholder="Admin"
              />
            </label>

            <label className={styles.label} htmlFor="email">
              Email
              <input
                id="email"
                name="email"
                type="email"
                required
                className={styles.input}
                placeholder="admin@example.com"
              />
            </label>

            <label className={styles.label} htmlFor="password">
              Password
              <input
                id="password"
                name="password"
                type="password"
                required
                minLength={8}
                className={styles.input}
                placeholder="Min. 8 characters"
              />
            </label>

            <label className={styles.label} htmlFor="confirm">
              Confirm Password
              <input
                id="confirm"
                name="confirm"
                type="password"
                required
                minLength={8}
                className={styles.input}
              />
            </label>

            {error && <p className={styles.error}>{error}</p>}

            <button type="submit" disabled={loading} className={styles.button}>
              {loading ? "Creating..." : "Create Admin Account"}
            </button>
          </form>
        </div>
      </div>
    );
}
