import type { ReactNode } from 'react';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { settingsPageTitle } from '@marinoscar/platform-web/settings/ui';

import { DESKTOP_SETTINGS_PATH, DESKTOP_SETTINGS_SECTIONS, DESKTOP_SETTINGS_TITLE } from './sections';

/**
 * What every settings page sits in: a way back to the hub and, unless the page
 * brings its own heading, the title the registry gives its path (the platform's
 * `settingsPageTitle`, the resolver the app bar uses too).
 */
export function SettingsPageFrame({ children, ownHeading = false }: { children: ReactNode; ownHeading?: boolean }) {
  const { pathname } = useLocation();
  const title = settingsPageTitle(DESKTOP_SETTINGS_SECTIONS, DESKTOP_SETTINGS_PATH, DESKTOP_SETTINGS_TITLE, pathname);
  return (
    <Stack spacing={2}>
      <Button component={RouterLink} to={DESKTOP_SETTINGS_PATH} startIcon={<ArrowBackIcon />} sx={{ alignSelf: 'flex-start' }}>
        {DESKTOP_SETTINGS_TITLE}
      </Button>
      {!ownHeading && title !== null && (
        <Typography variant="h4" component="h1">
          {title}
        </Typography>
      )}
      {children}
    </Stack>
  );
}
