import unittest
from unittest.mock import patch
import os
import sys

# Ensure backend folder is in Python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from auth import issue_token, verify_token_string, track_failed_attempt, is_ip_banned, clear_failed_attempts, BANNED_IPS, FAILED_ATTEMPTS
from rate_limit import ConnectionManager
from input_handler import InputValidator

class TestAuthentication(unittest.TestCase):
    def setUp(self):
        BANNED_IPS.clear()
        FAILED_ATTEMPTS.clear()

    def tearDown(self):
        BANNED_IPS.clear()
        FAILED_ATTEMPTS.clear()

    def test_jwt_issuance_and_verification(self):
        # Setup env variables for testing
        os.environ["SECRET_KEY"] = "test_signing_key_at_least_32_bytes_long"
        
        token = issue_token("admin", "administrator")
        payload = verify_token_string(token)
        
        self.assertEqual(payload.sub, "admin")
        self.assertEqual(payload.role, "administrator")

    def test_brute_force_ip_ban(self):
        ip = "192.168.1.50"
        self.assertFalse(is_ip_banned(ip))
        
        # Trigger 5 failed attempts
        for _ in range(5):
            track_failed_attempt(ip)
            
        self.assertTrue(is_ip_banned(ip))
        clear_failed_attempts(ip)
        BANNED_IPS.pop(ip, None)
        self.assertFalse(is_ip_banned(ip))

class TestRateLimiter(unittest.TestCase):
    def test_connection_limits(self):
        # Max 2 per IP, max 3 globally, max 99% memory limit
        cm = ConnectionManager(max_per_ip=2, max_global=3, max_memory_percent=99.0)
        
        # Add connections from IP 1
        self.assertTrue(cm.add_connection("1.1.1.1", "conn_1"))
        self.assertTrue(cm.add_connection("1.1.1.1", "conn_2"))
        
        # Third connection from IP 1 should be rejected (IP limit)
        self.assertFalse(cm.add_connection("1.1.1.1", "conn_3"))
        
        # Connection from IP 2 should succeed
        self.assertTrue(cm.add_connection("2.2.2.2", "conn_4"))
        
        # Fourth global connection should be rejected (global limit of 3 reached)
        self.assertFalse(cm.add_connection("3.3.3.3", "conn_5"))
        
        # Remove connection and check that global limit opens up
        cm.remove_connection("1.1.1.1", "conn_1")
        self.assertTrue(cm.add_connection("3.3.3.3", "conn_5"))

@patch("input_handler.pyautogui")
class TestInputValidation(unittest.TestCase):
    def setUp(self):
        self.validator = InputValidator()

    def test_mouse_coordinate_clamping(self, mock_pyautogui):
        # Valid relative input inside screen bounds [0.0, 1.0]
        valid_move = {"type": "mouse_move", "x": 0.5, "y": 0.5}
        result = self.validator.validate_and_execute(valid_move, 1920, 1080)
        self.assertEqual(result.get("status"), "success")
        mock_pyautogui.moveTo.assert_called_with(960, 540)
        
        # Out of bounds mouse move should raise ValueError
        invalid_move = {"type": "mouse_move", "x": -0.1, "y": 1.2}
        with self.assertRaises(ValueError):
            self.validator.validate_and_execute(invalid_move, 1920, 1080)

    def test_prohibited_key_rejection(self, mock_pyautogui):
        # Standard key input should pass and call write/press
        valid_key = {"type": "key_press", "key": "a"}
        result = self.validator.validate_and_execute(valid_key, 1920, 1080)
        self.assertEqual(result.get("status"), "success")
        mock_pyautogui.keyDown.assert_called_with("a")
        
        # Prohibited keys/combos (like win, command, etc.) should raise ValueError
        for bad_key in ["win", "left windows", "right windows", "menu", "command"]:
            payload = {"type": "key_press", "key": bad_key}
            with self.assertRaises(ValueError):
                self.validator.validate_and_execute(payload, 1920, 1080)

if __name__ == "__main__":
    unittest.main()
