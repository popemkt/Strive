import { HubConnection, HubConnectionBuilder, LogLevel } from '@microsoft/signalr';
import { PayloadAction } from '@reduxjs/toolkit';
import { Middleware, MiddlewareAPI } from 'redux';
import { ErrorCodes } from 'src/utils/errors';
import * as actions from './actions';
import { onInvokeFailed, onInvokeReturn } from './actions';
import { Options } from './types';

const defaultEvents: string[] = [
   'OnSynchronizeObjectState',
   'OnSynchronizedObjectUpdated',
   'OnError',
   'OnPermissionsUpdated',
];

type SignalRResult = {
   middleware: Middleware;
   getConnection: () => HubConnection | undefined;
};

export default (options: Options): SignalRResult => {
   const { url } = options;

   let connection: HubConnection | undefined;

   // Define the list of handlers, now that we have an instance of ReduxWebSocket.
   const handlers: {
      [s: string]: (middleware: MiddlewareAPI, action: any) => void;
   } = {
      [actions.joinConference.type]: async ({ dispatch, getState }, action) => {
         const conferenceId: string = action.payload.conferenceId;

         if (!connection) {
            const conferenceUrl =
               url + `?access_token=${options.getAccessToken(getState())}&conferenceId=${conferenceId}`;

            connection = new HubConnectionBuilder()
               .withUrl(conferenceUrl)
               .withAutomaticReconnect()
               .configureLogging(LogLevel.Information)
               .build();

            connection.on('OnConferenceJoinError', (err) => {
               dispatch(actions.onConferenceJoinError(err));
               dispatch(actions.close());
            });

            for (const eventName of defaultEvents) {
               connection.on(eventName, (args) => dispatch(actions.onEventOccurred(eventName)(args)));
            }

            try {
               await connection.start();
               connection.onclose((error) => dispatch(actions.onConferenceConnectionClosed(conferenceId, error)));
               connection.onreconnected(() => dispatch(actions.onConferenceReconnected(conferenceId)));
               connection.onreconnecting((error) => dispatch(actions.onConferenceReconnecting(conferenceId, error)));

               dispatch(actions.onConferenceJoined(conferenceId));
            } catch (error) {
               dispatch(
                  actions.onConferenceJoinError({
                     code: ErrorCodes.SignalRConnectionFailed,
                     message: error.toString(),
                     type: 'SignalR',
                  }),
               );
            }
         }
      },
      [actions.subscribeEvent.type]: ({ dispatch }, { payload: { name } }) => {
         if (connection) {
            console.log('subscribe ' + name);
            connection.on(name, (args) => dispatch(actions.onEventOccurred(name)(args)));
         }
      },
      [actions.send.type]: (_, { payload: { payload, name } }) => {
         if (connection) {
            connection.send(name, ...(payload ? [payload] : []));
         }
      },
      [actions.invoke.type]: ({ dispatch }, { payload: { payload, name } }) => {
         if (connection) {
            connection.invoke(name, ...(payload ? [payload] : [])).then(
               (returnVal) => {
                  dispatch(actions.onInvokeReturn(name)(returnVal));
               },
               (error) => dispatch(actions.onInvokeFailed(name)(error)),
            );
         }
      },
      [actions.close.type]: async () => {
         if (connection) {
            await connection.stop();
            connection = undefined;
         }
      },
   };

   // Middleware function.
   const middleware: Middleware = (store: MiddlewareAPI) => (next) => (action: PayloadAction) => {
      const { type } = action;

      // Check if action type matches prefix
      if (type) {
         const handler = handlers[type];

         if (handler) {
            try {
               handler(store, action);
            } catch (err) {
               console.error(err);
            }
         }
      }

      return next(action);
   };

   const getConnection = () => connection;

   return { middleware, getConnection };
};
