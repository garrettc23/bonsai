/**
 * Test bootstrap. Loaded via bunfig.toml's [test] preload.
 *
 * - Disables the humanizer's outbound Anthropic call. The humanizer is
 *   exercised end-to-end in production; unit tests for the negotiation
 *   agent need to stay hermetic, and adding an extra scripted response
 *   per outbound to every test would be heavy churn for little signal.
 *   Tests that specifically want to exercise the humanizer should unset
 *   this in their own setup or pass an opts.anthropic mock to humanize().
 */
process.env.BONSAI_DISABLE_HUMANIZER = "1";
