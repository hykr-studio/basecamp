// Durable runs: what the assistant says when a run that waited for an approval goes on.
import { defineMessages } from './define.js';

export const runMessages = defineMessages({
  en: {
    'run.approved': 'That was approved and is done: {summary}.',
    'run.rejected': 'That was rejected, so nothing changed: {summary}.',
    'run.expired': 'Nobody decided it in time, so nothing changed: {summary}.',
    'run.failed': "That was approved, but it couldn't be done: {reason}.",
    'run.couldNotContinue': "Your request was decided, but I couldn't continue: {reason}",
  },
  hi: {
    'run.approved': 'यह मंज़ूर हो गया और पूरा हो गया: {summary}।',
    'run.rejected': 'यह अस्वीकार हुआ, इसलिए कुछ नहीं बदला: {summary}।',
    'run.expired': 'समय पर किसी ने तय नहीं किया, इसलिए कुछ नहीं बदला: {summary}।',
    'run.failed': 'यह मंज़ूर हुआ, पर हो नहीं सका: {reason}।',
    'run.couldNotContinue': 'आपका अनुरोध तय हो गया, पर मैं आगे नहीं बढ़ सका: {reason}',
  },
  te: {
    'run.approved': 'ఇది అనుమతించబడింది, పూర్తయింది: {summary}.',
    'run.rejected': 'ఇది తిరస్కరించబడింది, కాబట్టి ఏమీ మారలేదు: {summary}.',
    'run.expired': 'సమయానికి ఎవరూ నిర్ణయించలేదు, కాబట్టి ఏమీ మారలేదు: {summary}.',
    'run.failed': 'ఇది అనుమతించబడింది, కానీ చేయలేకపోయాను: {reason}.',
    'run.couldNotContinue': 'మీ అభ్యర్థన నిర్ణయించబడింది, కానీ నేను కొనసాగించలేకపోయాను: {reason}',
  },
});
