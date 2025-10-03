import { createContext, useContext, useEffect, useState } from "react";
import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    onAuthStateChanged,
    signOut,
    GoogleAuthProvider,
    signInWithPopup,
} from "firebase/auth";
import { auth } from "./firbase";

 const userAuthContext = createContext();

export function UserAuthContextProvider( props ) {
    const [user, setUser] = useState({});

        function signUp(email, password) {
            // Return the promise so callers can handle success/errors consistently
            return createUserWithEmailAndPassword(auth, email, password);
        }

        function logIn(email, password) {
            return signInWithEmailAndPassword(auth, email, password);
        }
    function logOut() {
        return signOut(auth);
    }
    function googleSignIn() {
        const googleAuthProvider = new GoogleAuthProvider();
        return signInWithPopup(auth, googleAuthProvider);
    }

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (currentuser) => {
            console.log("Auth", currentuser);
            setUser(currentuser);
        });

        return () => {
            unsubscribe();
        };
    }, []);

    return (
        <userAuthContext.Provider
            value={{ user, logIn, signUp, logOut, googleSignIn }}
        >
            {props.children}
        </userAuthContext.Provider>
    );
}
// export default UserAuthContextProvider
export function useUserAuth() {
    return useContext(userAuthContext);
}