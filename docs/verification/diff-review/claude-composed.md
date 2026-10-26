I reviewed the diff in the Nexus dashboard. Please address these notes, and answer the questions.

1. **[QUESTION]** `greet.py` lines 2-4

   ```diff
    
    
    def greet(name, excited=False):
   ```

   Why is this the order the functions come in?

2. **[REQUESTED CHANGE]** `greet.py` lines 21-23

   ```diff
        for name in sys.argv[1:]:
            print(greet(name))
            print(farewell(name))
   ```

   Add a docstring to each function you added.
