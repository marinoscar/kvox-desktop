import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { desktopSettingsCards } from './registry';

/** `/settings`: every card of the registry, in order. */
export function SettingsPage() {
  return (
    <Stack spacing={3}>
      <Typography variant="h4" component="h1">
        Settings
      </Typography>
      {desktopSettingsCards.map(({ id, title, Component }) => (
        <Card key={id} id={id} variant="outlined">
          <CardContent>
            <Typography variant="h6" component="h2" gutterBottom>
              {title}
            </Typography>
            <Component />
          </CardContent>
        </Card>
      ))}
    </Stack>
  );
}
