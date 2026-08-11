import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";

export const dynamic = "force-dynamic";

export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const domain = process.env["GOOGLE_ALLOWED_DOMAIN"]?.trim() ?? "";
  const configured = Boolean(process.env["GOOGLE_CLIENT_ID"]?.trim());

  return (
    <Box sx={{ display: "grid", placeItems: "center", minHeight: "100vh", p: 3 }}>
      <Paper variant="outlined" sx={{ p: 4, maxWidth: 460, width: "100%" }}>
        <Typography variant="h1" sx={{ fontSize: 20 }}>spec</Typography>
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 3 }}>
          the grounding console
        </Typography>

        {error ? (
          <Alert severity="error" sx={{ mb: 2 }}>
            <b>Not signed in.</b> {error}
          </Alert>
        ) : null}

        {configured ? (
          <>
            <Typography variant="body2" sx={{ mb: 2.5 }}>
              Every decision here is recorded permanently under the name of whoever
              made it, so the console needs to know who you are before it will
              accept one. Reading needs it too, because the corpus describes a
              customer&rsquo;s authorization model.
            </Typography>
            <Button variant="contained" href="/api/auth/login" fullWidth>
              Continue with Google
            </Button>
            {domain ? (
              <Typography variant="body2" sx={{ color: "text.secondary", mt: 2, fontSize: 12.5 }}>
                Limited to <b>{domain}</b> accounts.
              </Typography>
            ) : null}
          </>
        ) : (
          <Alert severity="info">
            <b>No identity provider is configured.</b> Set <code>GOOGLE_CLIENT_ID</code>,{" "}
            <code>GOOGLE_CLIENT_SECRET</code>, <code>GOOGLE_REDIRECT_URI</code> and{" "}
            <code>GOOGLE_ALLOWED_DOMAIN</code>. Locally, run without them and set{" "}
            <code>SPEC_AUTHOR</code> instead.
          </Alert>
        )}
      </Paper>
    </Box>
  );
}
